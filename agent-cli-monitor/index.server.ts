import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAgentSessions, resolveAgentSummary, type AgentSessionSummary } from "./server/agents";
import { callAgentMcpTool, readAgentMcpEndpoint } from "./server/mcp";
import { listDevinInstances } from "./server/processes";
import { monitorCloseAgent, monitorSnapshot } from "./shared/monitor";

export default function contribute(server: PluginServerContext) {
  server.handle(monitorSnapshot, async (_input, { paseo }) => {
    const [instances, agents] = await Promise.all([
      listDevinInstances(),
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
          agent = await resolveAgentSummary(paseo, instance.agentId);
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
    const agents = await listAgentSessions(paseo);
    // The caller agent must be currently loaded by the daemon. Prefer live,
    // non-archived agents other than the close target; the target itself is a
    // last-resort caller (closing itself still executes server-side).
    const candidates = (agents?.items ?? [])
      .slice()
      .sort((a, b) => {
        const aScore = (a.id === agentId ? 2 : 0) + (a.archivedAt ? 1 : 0);
        const bScore = (b.id === agentId ? 2 : 0) + (b.archivedAt ? 1 : 0);
        return aScore - bScore;
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
