import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { formatMb, MONITOR_QUERY_KEY, MonitorScreen } from "./client/monitor";
import { monitorSnapshot } from "./shared/monitor";

function MonitorItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const snapshot = useRpc(monitorSnapshot);
  const query = useQuery({
    queryKey: MONITOR_QUERY_KEY,
    queryFn: () => snapshot({}),
    staleTime: Infinity,
  });
  const data = query.data;
  const summary = data ? `${data.instanceCount} · ${formatMb(data.totalRssBytes)} MB` : "…";
  return (
    <SidebarRow
      icon="Activity"
      label="Devin 实例"
      active={currentScreen?.screenId === "monitor"}
      trailing={
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
          {summary}
        </Text>
      }
      onPress={() => openScreen({ screenId: "monitor" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "monitor", title: "Devin 进程", Component: MonitorScreen });
  client.addSidebarFooterItem({ id: "monitor", title: "Devin 实例监控", Component: MonitorItem });
  client.addCommandCenterItem({
    id: "open-monitor",
    title: "打开 Devin 进程监控",
    icon: "Activity",
    keywords: ["devin", "process", "memory", "monitor", "cli"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "monitor" });
    },
  });
  return () => {};
}
