export interface AgentSessionSummary {
  id: string;
  title: string | null;
  provider: string | null;
  status: string;
  cwd: string | null;
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

export async function listAgentSessions(paseo: AgentsListApi): Promise<AgentSessionStats | null> {
  try {
    const { entries } = await paseo.agents.list();
    const byStatus: Record<string, number> = {};
    const items: AgentSessionSummary[] = [];
    for (const entry of entries) {
      const agent = unwrap(entry);
      if (!agent.id || !agent.status || agent.archivedAt) continue;
      byStatus[agent.status] = (byStatus[agent.status] ?? 0) + 1;
      items.push({
        id: agent.id.slice(0, 8),
        title: agent.title ?? null,
        provider: agent.provider ?? null,
        status: agent.status,
        cwd: agent.cwd ?? null,
      });
    }
    return { total: items.length, byStatus, items };
  } catch (error) {
    console.error("Failed to list agent sessions", error);
    return null;
  }
}
