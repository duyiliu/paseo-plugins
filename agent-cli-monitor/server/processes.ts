import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentSessionSummary } from "./agents";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface SystemCommit {
  committedBytes: number;
  commitLimitBytes: number;
}

export interface InstanceProcess {
  pid: number;
  name: string;
  rssBytes: number;
  privateBytes: number | null;
  command: string;
}

// One row per agent. An agent owns every process carrying its PASEO_AGENT_ID
// plus their descendants, collected into a pid set so overlapping trees are
// only counted once. `pid`/`name` identify the heaviest process in the set —
// that is what the row is about when you are hunting memory.
export interface AgentCliInstance {
  agentId: string;
  agentCwd: string | null;
  agent: AgentSessionSummary | null;
  pid: number;
  name: string;
  command: string;
  startedAt: string | null;
  processes: InstanceProcess[];
  processCount: number;
  totalRssBytes: number;
  totalPrivateBytes: number | null;
}

interface RawProcess {
  pid: number;
  ppid: number;
  name: string;
  rssBytes: number;
  privateBytes: number | null;
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
$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,CommandLine,CreationDate | ForEach-Object {
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
    PrivatePageCount = $_.PrivatePageCount
    CommandLine = $_.CommandLine
    StartedAt = $(if ($_.CreationDate) { ([datetime]$_.CreationDate).ToUniversalTime().ToString("o") } else { $null })
    AgentId = $agentId
    AgentCwd = $agentCwd
  }
})
$committed = $null
$limit = $null
$mem = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $mem) { $committed = $mem.CommittedBytes; $limit = $mem.CommitLimit }
[pscustomobject]@{
  processes = $rows
  committedBytes = $committed
  commitLimitBytes = $limit
} | ConvertTo-Json -Compress
`;

async function listWindows(): Promise<{ processes: RawProcess[]; systemCommit: SystemCommit | null }> {
  // Write the script on every invocation: temp cleaners may remove it between
  // refreshes, and rewriting also leaves no stale file for tampering.
  const scriptPath = join(tmpdir(), "paseo-agent-cli-monitor.ps1");
  await writeFile(scriptPath, WINDOWS_PS_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { maxBuffer: MAX_BUFFER },
  );
  const envelope = JSON.parse(stdout) as {
    processes?: unknown;
    committedBytes?: number | string | null;
    commitLimitBytes?: number | string | null;
  };
  const committedBytes = Number(envelope?.committedBytes);
  const commitLimitBytes = Number(envelope?.commitLimitBytes);
  const systemCommit =
    Number.isFinite(committedBytes) && committedBytes > 0 && Number.isFinite(commitLimitBytes) && commitLimitBytes > 0
      ? { committedBytes, commitLimitBytes }
      : null;
  const parsed = envelope?.processes;
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const out: RawProcess[] = [];
  for (const row of rows) {
    const r = row as {
      ProcessId?: number;
      ParentProcessId?: number;
      Name?: string;
      WorkingSetSize?: number;
      PrivatePageCount?: number | string | null;
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
      privateBytes: r.PrivatePageCount != null ? Number(r.PrivatePageCount) : null,
      command: r.CommandLine ?? "",
      startedAt: r.StartedAt ?? null,
      agentId: r.AgentId ?? null,
      agentCwd: r.AgentCwd ?? null,
    });
  }
  return { processes: out, systemCommit };
}

// `ps -o etime=` reports [[dd-]hh:]mm:ss — no locale issues unlike lstart.
function parseEtime(text: string): string | null {
  const match = /(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)/.exec(text);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  const elapsedMs = ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
  return new Date(Date.now() - elapsedMs).toISOString();
}

async function listPosix(): Promise<RawProcess[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss=,comm=,etime=,args="], {
    maxBuffer: MAX_BUFFER,
  });
  const out: RawProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pidText, ppidText, rssKbText, comm, etime, args] = match;
    out.push({
      pid: Number(pidText),
      ppid: Number(ppidText),
      name: comm.split("/").pop() ?? comm,
      rssBytes: Number(rssKbText) * 1024,
      privateBytes: null,
      command: args,
      startedAt: parseEtime(etime),
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

// The daemon stamps PASEO_AGENT_ID / PASEO_AGENT_CWD into every agent's launch
// environment (agent-manager), and descendants inherit them. Every process
// carrying the marker belongs to that agent, and so do its descendants — that
// is where most of the memory actually sits. Processes without the marker
// (manually started CLIs, desktop apps embedding the same binaries) are
// excluded entirely.
//
// Ownership is collected as a pid set rather than a tree walk from one root.
// An agent legitimately owns several marked processes — its launcher shell, a
// CLI that outlived it, a detached service — and their trees can be siblings
// whose parent has already exited. A set makes overlaps and orphans free.
function buildInstances(processes: RawProcess[]): AgentCliInstance[] {
  const childrenByPpid = new Map<number, RawProcess[]>();
  for (const proc of processes) {
    const list = childrenByPpid.get(proc.ppid);
    if (list) list.push(proc);
    else childrenByPpid.set(proc.ppid, [proc]);
  }

  const markedByAgent = new Map<string, RawProcess[]>();
  for (const proc of processes) {
    if (!proc.agentId) continue;
    const list = markedByAgent.get(proc.agentId);
    if (list) list.push(proc);
    else markedByAgent.set(proc.agentId, [proc]);
  }

  const instances: AgentCliInstance[] = [];
  for (const [agentId, marked] of markedByAgent) {
    // Fold every marked process and its descendants into one pid set. A child
    // carrying another agent's marker is that agent's business, not ours.
    const owned = new Map<number, RawProcess>();
    const queue = [...marked];
    while (queue.length > 0) {
      const proc = queue.shift()!;
      if (owned.has(proc.pid)) continue;
      owned.set(proc.pid, proc);
      for (const child of childrenByPpid.get(proc.pid) ?? []) {
        if (child.agentId && child.agentId !== agentId) continue;
        queue.push(child);
      }
    }

    const members = [...owned.values()];
    members.sort((a, b) => (b.privateBytes ?? b.rssBytes) - (a.privateBytes ?? a.rssBytes));
    const heaviest = members[0];
    let startedAt: string | null = null;
    let anyPrivate = false;
    let totalRssBytes = 0;
    let totalPrivateBytes = 0;
    for (const proc of members) {
      totalRssBytes += proc.rssBytes;
      if (proc.privateBytes != null) {
        anyPrivate = true;
        totalPrivateBytes += proc.privateBytes;
      }
      if (proc.startedAt && (startedAt == null || Date.parse(proc.startedAt) < Date.parse(startedAt))) {
        startedAt = proc.startedAt;
      }
    }

    instances.push({
      agentId,
      agentCwd: marked.find((proc) => proc.agentCwd)?.agentCwd ?? null,
      agent: null,
      pid: heaviest.pid,
      name: baseName(heaviest.name),
      command: truncate(heaviest.command, 240),
      startedAt,
      processes: members.map((proc) => ({
        pid: proc.pid,
        name: baseName(proc.name),
        rssBytes: proc.rssBytes,
        privateBytes: proc.privateBytes,
        command: truncate(proc.command, 240),
      })),
      processCount: members.length,
      totalRssBytes,
      totalPrivateBytes: anyPrivate ? totalPrivateBytes : null,
    });
  }

  // Sort by committed (private) bytes when available — that's what blows the
  // commit limit — falling back to RSS on platforms without the metric.
  return instances.sort((a, b) => (b.totalPrivateBytes ?? b.totalRssBytes) - (a.totalPrivateBytes ?? a.totalRssBytes));
}

// Linux reports the same commit-charge numbers as Windows' \Memory\ counters.
async function readLinuxSystemCommit(): Promise<SystemCommit | null> {
  try {
    const raw = await readFile("/proc/meminfo", "utf8");
    const committed = /^Committed_AS:\s*(\d+)\s+kB/im.exec(raw);
    const limit = /^CommitLimit:\s*(\d+)\s+kB/im.exec(raw);
    if (!committed || !limit) return null;
    return {
      committedBytes: Number(committed[1]) * 1024,
      commitLimitBytes: Number(limit[1]) * 1024,
    };
  } catch {
    return null;
  }
}

export interface AgentCliScan {
  instances: AgentCliInstance[];
  systemCommit: SystemCommit | null;
}

export async function listAgentCliInstances(): Promise<AgentCliScan> {
  let processes: RawProcess[];
  let systemCommit: SystemCommit | null = null;
  if (process.platform === "win32") {
    ({ processes, systemCommit } = await listWindows());
  } else {
    processes = await listPosix();
    if (process.platform === "linux") {
      systemCommit = await readLinuxSystemCommit();
    }
  }
  if (process.platform === "linux") {
    await fillLinuxEnvironments(processes);
  } else if (process.platform !== "win32") {
    await fillPsEnvironments(processes);
  }
  const instances = buildInstances(processes);
  return { instances, systemCommit };
}
