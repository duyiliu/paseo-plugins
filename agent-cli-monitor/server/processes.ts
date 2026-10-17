import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentSessionSummary } from "./agents";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const ROOT_NAME = "devin";

export interface ChildProcessInfo {
  pid: number;
  name: string;
  rssBytes: number;
}

export interface CliInstance {
  pid: number;
  rssBytes: number;
  command: string;
  startedAt: string | null;
  agentId: string | null;
  agentCwd: string | null;
  agent: AgentSessionSummary | null;
  children: ChildProcessInfo[];
  totalRssBytes: number;
}

interface RawProcess {
  pid: number;
  ppid: number;
  name: string;
  rssBytes: number;
  command: string;
  startedAt: string | null;
  agentId: string | null;
  agentCwd: string | null;
}

function baseName(name: string): string {
  const tail = name.split(/[\\/]/).pop() ?? name;
  return tail.replace(/\.exe$/i, "").toLowerCase();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

// Reads PASEO_AGENT_ID / PASEO_AGENT_CWD out of each devin.exe process
// environment block via the PEB (NtQueryInformationProcess + ReadProcessMemory).
const WINDOWS_PS_SCRIPT = String.raw`
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$source = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ProcEnv {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] pbi, int len, ref int retLen);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);

    public static string ReadEnvBlock(int pid, int maxBytes) {
        IntPtr h = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
        if (h == IntPtr.Zero) return "ERR:" + Marshal.GetLastWin32Error();
        try {
            byte[] pbi = new byte[48];
            int retLen = 0;
            int st = NtQueryInformationProcess(h, 0, pbi, pbi.Length, ref retLen);
            if (st != 0) return "ERR:0x" + st.ToString("x8");
            IntPtr peb = (IntPtr)BitConverter.ToInt64(pbi, 8);
            IntPtr pp = ReadPtr(h, (IntPtr)(peb.ToInt64() + 0x20));
            if (pp == IntPtr.Zero) return "ERR:ProcessParameters";
            IntPtr envPtr = ReadPtr(h, (IntPtr)(pp.ToInt64() + 0x80));
            if (envPtr == IntPtr.Zero) return "ERR:EnvironmentPtr";
            var sb = new StringBuilder();
            long offset = 0;
            int chunk = 8192;
            while (offset < maxBytes) {
                byte[] buf = new byte[chunk];
                IntPtr got;
                if (!ReadProcessMemory(h, (IntPtr)(envPtr.ToInt64() + offset), buf, (IntPtr)chunk, out got) || got.ToInt64() <= 0)
                    break;
                int n = (int)got.ToInt64();
                string s = Encoding.Unicode.GetString(buf, 0, n);
                sb.Append(s);
                if (s.IndexOf("\0\0") >= 0) break;
                offset += n;
            }
            return sb.ToString();
        } finally { CloseHandle(h); }
    }

    static IntPtr ReadPtr(IntPtr h, IntPtr addr) {
        byte[] buf = new byte[8];
        IntPtr got;
        if (!ReadProcessMemory(h, addr, buf, (IntPtr)8, out got) || got.ToInt64() != 8) return IntPtr.Zero;
        return (IntPtr)BitConverter.ToInt64(buf, 0);
    }
}
"@
Add-Type -TypeDefinition $source -Language CSharp
$cmds = @{}
$agentEnv = @{}
$created = @{}
Get-CimInstance Win32_Process -Filter "Name='devin.exe'" -Property ProcessId,CommandLine,CreationDate | ForEach-Object {
  $cmds[[string]$_.ProcessId] = $_.CommandLine
  if ($_.CreationDate) { $created[[string]$_.ProcessId] = ([datetime]$_.CreationDate).ToUniversalTime().ToString("o") }
  $agentId = $null
  $agentCwd = $null
  $block = [ProcEnv]::ReadEnvBlock([int]$_.ProcessId, 262144)
  if ($block -and -not $block.StartsWith("ERR:")) {
    foreach ($entry in ($block -split "\0")) {
      if ($entry.StartsWith("PASEO_AGENT_ID=")) { $agentId = $entry.Substring(15) }
      elseif ($entry.StartsWith("PASEO_AGENT_CWD=")) { $agentCwd = $entry.Substring(16) }
    }
  }
  $agentEnv[[string]$_.ProcessId] = @{ agentId = $agentId; agentCwd = $agentCwd }
}
$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,@{N='CommandLine';E={$cmds[[string]$_.ProcessId]}},@{N='StartedAt';E={$created[[string]$_.ProcessId]}},@{N='AgentId';E={$agentEnv[[string]$_.ProcessId].agentId}},@{N='AgentCwd';E={$agentEnv[[string]$_.ProcessId].agentCwd}})
if ($rows.Count -eq 0) { "[]" } else { $rows | ConvertTo-Json -Compress }
`;

let windowsScriptPath: string | null = null;

async function ensureWindowsScriptPath(): Promise<string> {
  if (windowsScriptPath) return windowsScriptPath;
  const target = join(tmpdir(), "paseo-agent-cli-monitor.ps1");
  await writeFile(target, WINDOWS_PS_SCRIPT, "utf8");
  windowsScriptPath = target;
  return target;
}

async function listWindows(): Promise<RawProcess[]> {
  const scriptPath = await ensureWindowsScriptPath();
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { maxBuffer: MAX_BUFFER },
  );
  const parsed = JSON.parse(stdout) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: RawProcess[] = [];
  for (const row of rows) {
    const r = row as {
      ProcessId?: number;
      ParentProcessId?: number;
      Name?: string;
      WorkingSetSize?: number;
      CommandLine?: string | null;
      StartedAt?: string | null;
      AgentId?: string | null;
      AgentCwd?: string | null;
    };
    if (!r.ProcessId || !r.Name) continue;
    out.push({
      pid: r.ProcessId,
      ppid: r.ParentProcessId ?? 0,
      name: r.Name,
      rssBytes: r.WorkingSetSize ?? 0,
      command: r.CommandLine ?? "",
      startedAt: r.StartedAt ?? null,
      agentId: r.AgentId ?? null,
      agentCwd: r.AgentCwd ?? null,
    });
  }
  return out;
}

async function readPosixAgentEnv(pid: number): Promise<{ agentId: string | null; agentCwd: string | null }> {
  const parse = (text: string) => {
    let agentId: string | null = null;
    let agentCwd: string | null = null;
    for (const entry of text.split("\0")) {
      if (entry.startsWith("PASEO_AGENT_ID=")) agentId = entry.slice(15);
      else if (entry.startsWith("PASEO_AGENT_CWD=")) agentCwd = entry.slice(16);
    }
    return { agentId, agentCwd };
  };
  try {
    const raw = await readFile(`/proc/${pid}/environ`);
    return parse(raw.toString("utf8"));
  } catch {
    try {
      const { stdout } = await execFileAsync("ps", ["eww", "-o", "command=", "-p", String(pid)], {
        maxBuffer: MAX_BUFFER,
      });
      const agentId = /PASEO_AGENT_ID=(\S+)/.exec(stdout)?.[1] ?? null;
      const agentCwd = /PASEO_AGENT_CWD=(\S+)/.exec(stdout)?.[1] ?? null;
      return { agentId, agentCwd };
    } catch {
      return { agentId: null, agentCwd: null };
    }
  }
}

// `ps -o etime=` reports [[dd-]hh:]mm:ss — no locale issues unlike lstart.
async function readPosixStartedAt(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "etime=", "-p", String(pid)], {
      maxBuffer: MAX_BUFFER,
    });
    const match = /(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)/.exec(stdout.trim());
    if (!match) return null;
    const days = Number(match[1] ?? 0);
    const hours = Number(match[2] ?? 0);
    const minutes = Number(match[3]);
    const seconds = Number(match[4]);
    const elapsedMs = ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
    return new Date(Date.now() - elapsedMs).toISOString();
  } catch {
    return null;
  }
}

async function listPosix(): Promise<RawProcess[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss=,comm=,args="], {
    maxBuffer: MAX_BUFFER,
  });
  const out: RawProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pidText, ppidText, rssKbText, comm, args] = match;
    out.push({
      pid: Number(pidText),
      ppid: Number(ppidText),
      name: comm.split("/").pop() ?? comm,
      rssBytes: Number(rssKbText) * 1024,
      command: args,
      startedAt: null,
      agentId: null,
      agentCwd: null,
    });
  }
  return out;
}

function buildInstances(processes: RawProcess[]): CliInstance[] {
  const childrenByPpid = new Map<number, RawProcess[]>();
  const byPid = new Map<number, RawProcess>();
  for (const proc of processes) {
    byPid.set(proc.pid, proc);
    const list = childrenByPpid.get(proc.ppid);
    if (list) list.push(proc);
    else childrenByPpid.set(proc.ppid, [proc]);
  }

  const isRoot = (proc: RawProcess) => {
    if (baseName(proc.name) !== ROOT_NAME) return false;
    // A devin process nested under another devin process is counted once, as part
    // of the ancestor's tree.
    let ancestor = byPid.get(proc.ppid);
    while (ancestor) {
      if (baseName(ancestor.name) === ROOT_NAME) return false;
      ancestor = byPid.get(ancestor.ppid);
    }
    return true;
  };

  const instances: CliInstance[] = [];
  for (const proc of processes) {
    if (!isRoot(proc)) continue;
    const children: ChildProcessInfo[] = [];
    const queue = [...(childrenByPpid.get(proc.pid) ?? [])];
    const seen = new Set<number>([proc.pid]);
    let total = proc.rssBytes;
    while (queue.length > 0) {
      const child = queue.shift()!;
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      total += child.rssBytes;
      children.push({ pid: child.pid, name: child.name, rssBytes: child.rssBytes });
      for (const grandchild of childrenByPpid.get(child.pid) ?? []) queue.push(grandchild);
    }
    children.sort((a, b) => b.rssBytes - a.rssBytes);
    instances.push({
      pid: proc.pid,
      rssBytes: proc.rssBytes,
      command: truncate(proc.command, 240),
      startedAt: proc.startedAt,
      agentId: proc.agentId,
      agentCwd: proc.agentCwd,
      agent: null,
      children,
      totalRssBytes: total,
    });
  }
  return instances.sort((a, b) => b.totalRssBytes - a.totalRssBytes);
}

export async function listDevinInstances(): Promise<CliInstance[]> {
  const processes = process.platform === "win32" ? await listWindows() : await listPosix();
  const instances = buildInstances(processes);
  if (process.platform !== "win32") {
    await Promise.all(
      instances.map(async (instance) => {
        const [env, startedAt] = await Promise.all([
          readPosixAgentEnv(instance.pid),
          readPosixStartedAt(instance.pid),
        ]);
        instance.agentId = env.agentId;
        instance.agentCwd = env.agentCwd;
        instance.startedAt = startedAt;
      }),
    );
  }
  return instances;
}
