import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Text } from "react-native";
import { formatMb, MONITOR_QUERY_KEY, MonitorScreen } from "./client/monitor";
import { monitorSnapshot } from "./shared/monitor";

function MonitorItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const paseo = usePaseo();
  const snapshot = useRpc(monitorSnapshot);
  const query = useQuery({
    queryKey: MONITOR_QUERY_KEY,
    queryFn: () => snapshot({}),
    staleTime: Infinity,
  });
  const refetch = useRef(query.refetch);
  refetch.current = query.refetch;

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    let release: (() => Promise<void>) | null = null;
    let quickRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let settledRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const agentStatuses = new Map<string, string>();

    const rememberSnapshot = (entries: readonly unknown[]) => {
      agentStatuses.clear();
      for (const entry of entries) {
        const candidate = entry as {
          id?: string;
          status?: string;
          agent?: { id?: string; status?: string };
        };
        const agent = candidate.agent ?? candidate;
        if (agent.id && agent.status) agentStatuses.set(agent.id, agent.status);
      }
    };

    const scheduleRefresh = () => {
      if (!quickRefreshTimer) {
        quickRefreshTimer = setTimeout(() => {
          quickRefreshTimer = null;
          if (!disposed) void refetch.current();
        }, 1_000);
      }
      if (settledRefreshTimer) clearTimeout(settledRefreshTimer);
      settledRefreshTimer = setTimeout(() => {
        settledRefreshTimer = null;
        if (!disposed) void refetch.current();
      }, 10_000);
    };

    const observeAgents = async () => {
      const result = await paseo.agents.list({
        filter: { includeArchived: true },
        subscribe: {},
      });
      if (disposed) {
        await result.subscription?.release();
        return;
      }

      rememberSnapshot(result.entries);
      const subscription = result.subscription;
      if (!subscription) return;
      release = () => subscription.release();
      unsubscribe = subscription.subscribe({
        snapshot: (next) => rememberSnapshot(next.entries),
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            if (agentStatuses.delete(update.agentId)) scheduleRefresh();
            return;
          }

          const previousStatus = agentStatuses.get(update.agent.id);
          const created = previousStatus === undefined;
          const closed = previousStatus !== "closed" && update.agent.status === "closed";
          agentStatuses.set(update.agent.id, update.agent.status);
          if (created || closed) scheduleRefresh();
        },
        error: (error) => console.error("Agent CLI Monitor subscription failed", error),
      });
    };

    void observeAgents().catch((error) => {
      if (!disposed) console.error("Agent CLI Monitor could not subscribe to agents", error);
    });

    return () => {
      disposed = true;
      if (quickRefreshTimer) clearTimeout(quickRefreshTimer);
      if (settledRefreshTimer) clearTimeout(settledRefreshTimer);
      unsubscribe?.();
      if (release) void release();
    };
  }, [paseo]);

  const data = query.data;
  const commitRatio =
    data?.system && data.system.commitLimitBytes > 0
      ? data.system.committedBytes / data.system.commitLimitBytes
      : null;
  const summary = data
    ? data.totalPrivateBytes != null
      ? `${data.instanceCount} · ${formatMb(data.totalRssBytes)}/${formatMb(data.totalPrivateBytes)} MB`
      : `${data.instanceCount} · ${formatMb(data.totalRssBytes)} MB`
    : "…";
  const summaryColor =
    commitRatio != null && commitRatio >= 0.9
      ? theme.colors.statusDanger
      : commitRatio != null && commitRatio >= 0.75
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;
  return (
    <SidebarRow
      icon="Activity"
      label="Agent 实例"
      active={currentScreen?.screenId === "monitor"}
      trailing={
        <Text style={{ color: summaryColor, fontSize: 11, fontVariant: ["tabular-nums"] }}>
          {summary}
        </Text>
      }
      onPress={() => openScreen({ screenId: "monitor" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "monitor", title: "Agent 进程", Component: MonitorScreen });
  client.addSidebarFooterItem({ id: "monitor", title: "Agent 实例监控", Component: MonitorItem });
  client.addCommandCenterItem({
    id: "open-monitor",
    title: "打开 Agent 进程监控",
    icon: "Activity",
    keywords: ["agent", "devin", "claude", "codex", "process", "memory", "monitor", "cli"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "monitor" });
    },
  });
  return () => {};
}
