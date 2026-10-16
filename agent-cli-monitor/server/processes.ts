import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  children: ChildProcessInfo[];
  totalRssBytes: number;
}

interface RawProcess {
  pid: number;
  ppid: number;
  name: string;
  rssBytes: number;
  command: string;
}

function baseName(name: string): string {
  const tail = name.split(/[\\/]/).pop() ?? name;
  return tail.replace(/\.exe$/i, "").toLowerCase();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

async function listWindows(): Promise<RawProcess[]> {
  const script = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
    "$cmds = @{};",
    "Get-CimInstance Win32_Process -Filter \"Name='devin.exe'\" -Property ProcessId,CommandLine |",
    "  ForEach-Object { $cmds[[string]$_.ProcessId] = $_.CommandLine };",
    "Get-CimInstance Win32_Process |",
    "  Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,@{N='CommandLine';E={$cmds[[string]$_.ProcessId]}} |",
    "  ConvertTo-Json -Compress",
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
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
    };
    if (!r.ProcessId || !r.Name) continue;
    out.push({
      pid: r.ProcessId,
      ppid: r.ParentProcessId ?? 0,
      name: r.Name,
      rssBytes: r.WorkingSetSize ?? 0,
      command: r.CommandLine ?? "",
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
      children,
      totalRssBytes: total,
    });
  }
  return instances.sort((a, b) => b.totalRssBytes - a.totalRssBytes);
}

export async function listDevinInstances(): Promise<CliInstance[]> {
  const processes = process.platform === "win32" ? await listWindows() : await listPosix();
  return buildInstances(processes);
}
