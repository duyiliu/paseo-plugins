import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { monitorSnapshot } from "../shared/monitor";

export const MONITOR_QUERY_KEY = ["agent-cli-monitor.snapshot"];
export const MONITOR_REFETCH_MS = 5 * 60 * 1000;

export function formatMb(bytes: number): string {
  return (bytes / 1048576).toFixed(0);
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

export function MonitorScreen({ theme, layout }: PluginScreenProps) {
  const snapshot = useRpc(monitorSnapshot);
  const query = useQuery({
    queryKey: MONITOR_QUERY_KEY,
    queryFn: () => snapshot({}),
    refetchInterval: MONITOR_REFETCH_MS,
  });
  const data = query.data;
  const compact = layout.compact;
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: compact ? 16 : 24,
        gap: compact ? 10 : 14,
        backgroundColor: theme.colors.surface0,
      },
      statsRow: { flexDirection: "row" as const, gap: compact ? 16 : 28, alignItems: "flex-end" as const },
      statValue: { color: theme.colors.foreground, fontSize: compact ? 28 : 36, fontVariant: ["tabular-nums" as const] },
      statLabel: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 13 },
      sectionTitle: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 },
      instanceRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.foregroundMuted,
      },
      name: { color: theme.colors.foreground, flex: 1, fontSize: 13 },
      pid: { color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums" as const] },
      mem: {
        color: theme.colors.foreground,
        fontSize: 13,
        width: 90,
        textAlign: "right" as const,
        fontVariant: ["tabular-nums" as const],
      },
      childRow: { color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: 18 },
      command: { color: theme.colors.foregroundMuted, fontSize: 11, marginBottom: 4 },
      button: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 13 },
      mutedText: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, compact],
  );

  const statusSummary = data?.agents
    ? Object.entries(data.agents.byStatus)
        .map(([status, count]) => `${status} ${count}`)
        .join(" · ")
    : null;

  return (
    <View style={styles.screen}>
      <View style={styles.statsRow}>
        <View>
          <Text style={styles.statValue}>{data ? data.instanceCount : "…"}</Text>
          <Text style={styles.statLabel}>个 devin 实例</Text>
        </View>
        <View>
          <Text style={styles.statValue}>{data ? formatMb(data.totalRssBytes) : "…"}</Text>
          <Text style={styles.statLabel}>MB 总内存(含子进程)</Text>
        </View>
        <View>
          <Text style={styles.statLabel}>{data ? `更新于 ${formatClock(data.collectedAt)}` : "加载中"}</Text>
          <Text style={styles.statLabel}>{statusSummary ? `会话:${statusSummary}` : ""}</Text>
        </View>
      </View>

      {query.isError ? (
        <Text style={styles.mutedText}>
          采集失败:{query.error instanceof Error ? query.error.message : String(query.error)}
        </Text>
      ) : null}

      <Text style={styles.sectionTitle}>实例明细</Text>
      <ScrollView style={{ flex: 1 }}>
        {(data?.instances ?? []).map((instance) => (
          <View key={instance.pid}>
            <View style={styles.instanceRow}>
              <Text style={styles.name} numberOfLines={1}>
                devin
              </Text>
              <Text style={styles.pid}>{instance.pid}</Text>
              <Text style={styles.mem}>{formatMb(instance.totalRssBytes)} MB</Text>
            </View>
            <Text style={styles.command} numberOfLines={1}>
              {instance.command}
            </Text>
            {instance.children.map((child) => (
              <Text key={child.pid} style={styles.childRow} numberOfLines={1}>
                └ {child.name} {child.pid} {formatMb(child.rssBytes)} MB
              </Text>
            ))}
          </View>
        ))}
        {data && data.instances.length === 0 ? (
          <Text style={styles.mutedText}>当前没有运行中的 devin 进程。</Text>
        ) : null}
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="立即刷新"
        style={styles.button}
        onPress={() => void query.refetch()}
      >
        <Text style={styles.buttonText}>刷新</Text>
      </Pressable>
    </View>
  );
}
