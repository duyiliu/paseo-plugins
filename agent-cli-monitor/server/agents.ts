import { readAgentRecordJson } from "./records";

export interface AgentSessionSummary {
  id: string;
  title: string | null;
  provider: string | null;
  status: string;
  cwd: string | null;
  archivedAt: string | null;
}

export interface AgentSessionStats {
  total: number;
  byStatus: Record<string, number>;
  items: AgentSessionSummary[];
}

interface AgentsListApi {
  agents: {
    list(input?: unknown): Promise<{ entries: unknown[] }>;
  };
}

interface RawAgent {
  id?: string;
  title?: string | null;
  provider?: string | null;
  status?: string;
  cwd?: string | null;
  archivedAt?: string | null;
}

function unwrap(entry: unknown): RawAgent {
  const candidate = entry as { agent?: RawAgent } & RawAgent;
  return candidate.agent ?? candidate;
}

function toSummary(agent: RawAgent): AgentSessionSummary | null {
  if (!agent.id || !agent.status) return null;
  return {
    id: agent.id,
    title: agent.title ?? null,
    provider: agent.provider ?? null,
    status: agent.status,
    cwd: agent.cwd ?? null,
    archivedAt: agent.archivedAt ?? null,
  };
}

export async function listAgentSessions(paseo: AgentsListApi): Promise<AgentSessionStats | null> {
  try {
    const { entries } = await paseo.agents.list({
      filter: { includeArchived: true },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200 },
    });
    const byStatus: Record<string, number> = {};
    const items: AgentSessionSummary[] = [];
    for (const entry of entries) {
      const summary = toSummary(unwrap(entry));
      if (!summary) continue;
      // Archived agents stay in items so live processes can still resolve names,
      // but they do not count toward the session summary.
      if (!summary.archivedAt) {
        byStatus[summary.status] = (byStatus[summary.status] ?? 0) + 1;
      }
      items.push(summary);
    }
    const total = items.filter((item) => !item.archivedAt).length;
    return { total, byStatus, items };
  } catch (error) {
    console.error("Failed to list agent sessions", error);
    return null;
  }
}

// Fallback for agents outside the list window: read the persisted record
// directly. Do NOT use agents.ref(id).refresh() here — the daemon handles it
// via ensureAgentLoaded, which spawns the provider process just to answer a
// metadata query.
export async function resolveAgentSummary(id: string): Promise<AgentSessionSummary | null> {
  const record = await readAgentRecordJson(id);
  if (!record) return null;
  return {
    id,
    title: record.title ?? null,
    provider: record.provider ?? null,
    status: record.lastStatus ?? "unknown",
    cwd: record.cwd ?? null,
    archivedAt: record.archivedAt ?? null,
  };
}
