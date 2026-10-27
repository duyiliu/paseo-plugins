import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

export interface AgentRecord {
  id?: string;
  title?: string | null;
  provider?: string | null;
  lastStatus?: string;
  cwd?: string | null;
  workspaceId?: string | null;
  lastActivityAt?: string | null;
  lastUserMessageAt?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  persistence?: {
    metadata?: {
      mcpServers?: {
        paseo?: { url?: string; headers?: { Authorization?: string } };
      };
    };
  };
}

// Agent records live at <PASEO_HOME>/agents/<workspace-slug>/<agentId>.json.
// Reading them directly is side-effect free — unlike agents.ref().refresh(),
// which makes the daemon load (and spawn a provider process for) the agent.
export async function readAgentRecordJson(agentId: string): Promise<AgentRecord | null> {
  const agentsRoot = join(paseoHome(), "agents");
  let dirs: string[];
  try {
    dirs = await readdir(agentsRoot);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(agentsRoot, dir, `${agentId}.json`), "utf8");
      return JSON.parse(raw) as AgentRecord;
    } catch {
      continue;
    }
  }
  return null;
}

export interface AgentActivity {
  lastUserMessageAt: string | null;
  lastActivityAt: string | null;
}

// The agents list API exposes lastActivityAt, which the daemon refreshes when
// it loads an agent (including its startup sweep), so it says nothing about
// whether the user ever touched the session. The persisted record carries
// lastUserMessageAt — the honest "last used" — so scan the records once.
export async function listAgentActivity(): Promise<Map<string, AgentActivity>> {
  const activity = new Map<string, AgentActivity>();
  const agentsRoot = join(paseoHome(), "agents");
  let dirs: string[];
  try {
    dirs = await readdir(agentsRoot);
  } catch {
    return activity;
  }
  await Promise.all(
    dirs.map(async (dir) => {
      let files: string[];
      try {
        files = await readdir(join(agentsRoot, dir));
      } catch {
        return;
      }
      await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            try {
              const raw = await readFile(join(agentsRoot, dir, file), "utf8");
              const record = JSON.parse(raw) as AgentRecord;
              if (!record.id) return;
              activity.set(record.id, {
                lastUserMessageAt: record.lastUserMessageAt ?? null,
                lastActivityAt: record.lastActivityAt ?? record.updatedAt ?? null,
              });
            } catch {
              // Skip unreadable or malformed records.
            }
          }),
      );
    }),
  );
  return activity;
}

// Workspace records live in <PASEO_HOME>/projects/workspaces.json — a flat
// array of { workspaceId, title, cwd, ... }. Same side-effect-free read as the
// agent records; the title is what the sidebar lists for the workspace.
export async function listWorkspaceTitles(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const raw = await readFile(join(paseoHome(), "projects", "workspaces.json"), "utf8");
    const rows = JSON.parse(raw) as { workspaceId?: string; title?: string | null }[];
    for (const row of rows) {
      if (row.workspaceId && row.title) titles.set(row.workspaceId, row.title);
    }
  } catch {
    // Missing or unreadable file — titles stay unresolved.
  }
  return titles;
}
