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
