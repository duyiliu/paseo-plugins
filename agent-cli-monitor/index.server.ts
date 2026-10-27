import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAgentSessions, resolveAgentSummary, type AgentSessionSummary } from "./server/agents";
import { callAgentMcpTool, readAgentMcpEndpoint } from "./server/mcp";
import { listAgentCliInstances } from "./server/processes";
import { monitorCloseAgent, monitorSnapshot } from "./shared/monitor";

// Raw MCP failures are opaque; map the common ones to actionable guidance.
function describeCloseError(raw: string): string {
  if (/401|403|unauthorized|forbidden|invalid.*(token|credential)|bearer/i.test(raw)) {
    return "调用凭证已失效(daemon 重启后常见),请先在 Paseo 里重新打开该 agent 再试";
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(raw)) {
    return "无法连接 daemon,请确认它仍在运行";
  }
  if (/timeout|ETIMEDOUT|aborted/i.test(raw)) {
    return "调用超时,agent 可能无响应";
  }
  return raw;
}

export default function contribute(server: PluginServerContext) {
  server.handle(monitorSnapshot, async (_input, { paseo }) => {
    const [{ instances, systemCommit }, agents] = await Promise.all([
      listAgentCliInstances(),
      listAgentSessions(paseo),
    ]);
    const agentById = new Map<string, AgentSessionSummary>(
      (agents?.items ?? []).map((item) => [item.id, item]),
    );
    await Promise.all(
      instances.map(async (instance) => {
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
    const anyPrivate = instances.some((item) => item.totalPrivateBytes != null);
    return {
      collectedAt: new Date().toISOString(),
      platform: process.platform,
      instanceCount: instances.length,
      processCount: instances.reduce((sum, item) => sum + item.processCount, 0),
      totalRssBytes: instances.reduce((sum, item) => sum + item.totalRssBytes, 0),
      totalPrivateBytes: anyPrivate
        ? instances.reduce((sum, item) => sum + (item.totalPrivateBytes ?? 0), 0)
        : null,
      system: systemCommit,
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
      liveInstances.instances.map((i) => i.agentId).filter((id): id is string => !!id),
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
    const messages = [...new Set(errors.map(describeCloseError))];
    return {
      ok: false,
      error: messages.join("; ") || "没有可用的调用方 agent",
    };
  });
  return () => {};
}
