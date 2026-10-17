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
    ref(id: string): {
      refresh(): Promise<{ agent: unknown } | null>;
    };
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

export async function resolveAgentSummary(
  paseo: AgentsListApi,
  id: string,
): Promise<AgentSessionSummary | null> {
  try {
    const result = await paseo.agents.ref(id).refresh();
    if (!result?.agent) return null;
    return toSummary(result.agent as RawAgent);
  } catch {
    return null;
  }
}
