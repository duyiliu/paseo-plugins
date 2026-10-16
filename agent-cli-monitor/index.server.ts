import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAgentSessions } from "./server/agents";
import { listDevinInstances } from "./server/processes";
import { monitorSnapshot } from "./shared/monitor";

export default function contribute(server: PluginServerContext) {
  server.handle(monitorSnapshot, async (_input, { paseo }) => {
    const [instances, agents] = await Promise.all([
      listDevinInstances(),
      listAgentSessions(paseo),
    ]);
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
  return () => {};
}
