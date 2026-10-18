import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentSessionSummary } from "./agents";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface ChildProcessInfo {
  pid: number;
  name: string;
  rssBytes: number;
}

export interface AgentCliInstance {
  pid: number;
  name: string;
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

function parseEnvMarker(text: string): { agentId: string | null; agentCwd: string | null } {
  let agentId: string | null = null;
  let agentCwd: string | null = null;
  for (const entry of text.split("\0")) {
    if (entry.startsWith("PASEO_AGENT_ID=")) agentId = entry.slice(15);
    else if (entry.startsWith("PASEO_AGENT_CWD=")) agentCwd = entry.slice(16);
  }
  return { agentId, agentCwd };
}

// Reads PASEO_AGENT_ID / PASEO_AGENT_CWD out of every process's environment
// block via the PEB (NtQueryInformationProcess + ReadProcessMemory). The full
// scan costs roughly a quarter second for ~400 processes, so no name prefilter
// is needed — the env marker itself decides what is an agent.
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
$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine,CreationDate | ForEach-Object {
  $agentId = $null
  $agentCwd = $null
  $block = [ProcEnv]::ReadEnvBlock([int]$_.ProcessId, 262144)
  if ($block -and -not $block.StartsWith("ERR:")) {
    foreach ($entry in ($block -split "\0")) {
      if ($entry.StartsWith("PASEO_AGENT_ID=")) { $agentId = $entry.Substring(15) }
      elseif ($entry.StartsWith("PASEO_AGENT_CWD=")) { $agentCwd = $entry.Substring(16) }
    }
  }
  [pscustomobject]@{
    ProcessId = $_.ProcessId
    ParentProcessId = $_.ParentProcessId
    Name = $_.Name
    WorkingSetSize = $_.WorkingSetSize
    CommandLine = $_.CommandLine
    StartedAt = $(if ($_.CreationDate) { ([datetime]$_.CreationDate).ToUniversalTime().ToString("o") } else { $null })
    AgentId = $agentId
    AgentCwd = $agentCwd
  }
})
if ($rows.Count -eq 0) { "[]" } else { $rows | ConvertTo-Json -Compress }
`;

async function listWindows(): Promise<RawProcess[]> {
  // Write the script on every invocation: temp cleaners may remove it between
  // refreshes, and rewriting also leaves no stale file for tampering.
  const scriptPath = join(tmpdir(), "paseo-agent-cli-monitor.ps1");
  await writeFile(scriptPath, WINDOWS_PS_SCRIPT, "utf8");
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

// Linux exposes exact per-process environments through /proc.
async function fillLinuxEnvironments(processes: RawProcess[]): Promise<void> {
  await Promise.all(
    processes.map(async (proc) => {
      try {
        const raw = await readFile(`/proc/${proc.pid}/environ`);
        const env = parseEnvMarker(raw.toString("utf8"));
        proc.agentId = env.agentId;
        proc.agentCwd = env.agentCwd;
      } catch {
        // Unreadable (kernel threads, other users) — stays unmarked.
      }
    }),
  );
}

// Other POSIX systems (macOS) have no /proc; `ps eww` appends the environment
// after the command line for processes owned by the caller.
async function fillPsEnvironments(processes: RawProcess[]): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["eww", "-Ao", "pid=,command="], {
      maxBuffer: MAX_BUFFER,
    }));
  } catch {
    return;
  }
  const envByPid = new Map<number, { agentId: string | null; agentCwd: string | null }>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const tail = match[2];
    const agentId = /PASEO_AGENT_ID=(\S+)/.exec(tail)?.[1] ?? null;
    if (!agentId) continue;
    const agentCwd =
      /PASEO_AGENT_CWD=(.+?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/.exec(tail)?.[1] ?? null;
    envByPid.set(Number(match[1]), { agentId, agentCwd });
  }
  for (const proc of processes) {
    const env = envByPid.get(proc.pid);
    if (env) {
      proc.agentId = env.agentId;
      proc.agentCwd = env.agentCwd;
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

// The daemon stamps PASEO_AGENT_ID / PASEO_AGENT_CWD into every agent's launch
// environment (agent-manager), and descendants inherit them. A process is an
// instance root when it carries the marker and its parent carries a different
// one (or none): nested agents still get their own instance. Processes without
// the marker — manually started CLIs, desktop apps embedding the same
// binaries — are excluded entirely.
function buildInstances(processes: RawProcess[]): AgentCliInstance[] {
  const childrenByPpid = new Map<number, RawProcess[]>();
  const byPid = new Map<number, RawProcess>();
  for (const proc of processes) {
    byPid.set(proc.pid, proc);
    const list = childrenByPpid.get(proc.ppid);
    if (list) list.push(proc);
    else childrenByPpid.set(proc.ppid, [proc]);
  }

  const collectTree = (root: RawProcess): { children: ChildProcessInfo[]; total: number } => {
    const children: ChildProcessInfo[] = [];
    const queue = [...(childrenByPpid.get(root.pid) ?? [])];
    const seen = new Set<number>([root.pid]);
    let total = root.rssBytes;
    while (queue.length > 0) {
      const child = queue.shift()!;
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      // A child carrying a different PASEO_AGENT_ID is another agent's root;
      // its subtree belongs to that instance, not this one.
      if (child.agentId && child.agentId !== root.agentId) continue;
      total += child.rssBytes;
      children.push({ pid: child.pid, name: child.name, rssBytes: child.rssBytes });
      for (const grandchild of childrenByPpid.get(child.pid) ?? []) queue.push(grandchild);
    }
    children.sort((a, b) => b.rssBytes - a.rssBytes);
    return { children, total };
  };

  const toInstance = (proc: RawProcess): AgentCliInstance => {
    const { children, total } = collectTree(proc);
    return {
      pid: proc.pid,
      name: baseName(proc.name),
      rssBytes: proc.rssBytes,
      command: truncate(proc.command, 240),
      startedAt: proc.startedAt,
      agentId: proc.agentId,
      agentCwd: proc.agentCwd,
      agent: null,
      children,
      totalRssBytes: total,
    };
  };

  const instances: AgentCliInstance[] = [];
  for (const proc of processes) {
    if (!proc.agentId) continue;
    const parent = byPid.get(proc.ppid);
    if (parent?.agentId === proc.agentId) continue;
    instances.push(toInstance(proc));
  }

  return instances.sort((a, b) => b.totalRssBytes - a.totalRssBytes);
}

export async function listAgentCliInstances(): Promise<AgentCliInstance[]> {
  const processes =
    process.platform === "win32" ? await listWindows() : await listPosix();
  if (process.platform === "linux") {
    await fillLinuxEnvironments(processes);
  } else if (process.platform !== "win32") {
    await fillPsEnvironments(processes);
  }
  const instances = buildInstances(processes);
  if (process.platform !== "win32") {
    await Promise.all(
      instances.map(async (instance) => {
        instance.startedAt = await readPosixStartedAt(instance.pid);
      }),
    );
  }
  return instances;
}
