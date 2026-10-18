import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAgentSessions, resolveAgentSummary, type AgentSessionSummary } from "./server/agents";
import { callAgentMcpTool, readAgentMcpEndpoint } from "./server/mcp";
import { listAgentCliInstances } from "./server/processes";
import { monitorCloseAgent, monitorSnapshot } from "./shared/monitor";

export default function contribute(server: PluginServerContext) {
  server.handle(monitorSnapshot, async (_input, { paseo }) => {
    const [instances, agents] = await Promise.all([
      listAgentCliInstances(),
      listAgentSessions(paseo),
    ]);
    const agentById = new Map<string, AgentSessionSummary>(
      (agents?.items ?? []).map((item) => [item.id, item]),
    );
    await Promise.all(
      instances.map(async (instance) => {
        if (!instance.agentId) {
          instance.agent = null;
          return;
        }
        let agent = agentById.get(instance.agentId) ?? null;
        if (!agent) {
          agent = await resolveAgentSummary(instance.agentId);
          if (agent) {
            agentById.set(agent.id, agent);
            agents?.items.push(agent);
          }
        }
        instance.agent = agent;
      }),
    );
    return {
      collectedAt: new Date().toISOString(),
      platform: process.platform,
      instanceCount: instances.length,
      processCount: instances.reduce((sum, item) => sum + item.children.length + 1, 0),
      totalRssBytes: instances.reduce((sum, item) => sum + item.totalRssBytes, 0),
      instances,
      agents,
    };
  });

  server.handle(monitorCloseAgent, async ({ agentId }, { paseo }) => {
    const [agents, liveInstances] = await Promise.all([
      listAgentSessions(paseo),
      listAgentCliInstances(),
    ]);
    // The caller must be currently loaded by the daemon — agents owning a live
    // CLI process provably are. Try them first, then the target itself (also
    // loaded whenever it has a process), then the rest as a fallback sweep.
    const liveIds = new Set(
      liveInstances.map((i) => i.agentId).filter((id): id is string => !!id),
    );
    const candidates = (agents?.items ?? [])
      .slice()
      .sort((a, b) => {
        const score = (s: AgentSessionSummary) =>
          (liveIds.has(s.id) ? 0 : 100) + (s.id === agentId ? 10 : 0) + (s.archivedAt ? 5 : 0);
        return score(a) - score(b);
      });
    const errors: string[] = [];
    for (const caller of candidates) {
      const endpoint = await readAgentMcpEndpoint(caller.id);
      if (!endpoint) continue;
      const result = await callAgentMcpTool(endpoint, "kill_agent", { agentId });
      if (result.ok) return { ok: true, error: null };
      errors.push(`${caller.id.slice(0, 7)}: ${result.error}`);
    }
    return {
      ok: false,
      error: errors.join("; ") || "没有可用的调用方 agent",
    };
  });
  return () => {};
}
