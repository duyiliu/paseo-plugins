import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { monitorCloseAgent, monitorSnapshot } from "../shared/monitor";

export const MONITOR_QUERY_KEY = ["agent-cli-monitor.snapshot"];

export function formatMb(bytes: number): string {
  return (bytes / 1048576).toFixed(0);
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

function formatAge(iso: string): string | null {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d`;
}

export function MonitorScreen({ theme, layout, navigation }: PluginScreenProps) {
  const snapshot = useRpc(monitorSnapshot);
  const closeAgent = useRpc(monitorCloseAgent);
  const query = useQuery({
    queryKey: MONITOR_QUERY_KEY,
    queryFn: () => snapshot({}),
    staleTime: Infinity,
  });
  const data = query.data;
  const compact = layout.compact;
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [closingPid, setClosingPid] = useState<number | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClose = (pid: number, agentId: string | null | undefined) => {
    if (!agentId || closingPid === pid) return;
    if (confirmPid !== pid) {
      setConfirmPid(pid);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmPid(null), 3000);
      return;
    }
    setConfirmPid(null);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setClosingPid(pid);
    setCloseError(null);
    void closeAgent({ agentId })
      .then((res) => {
        if (!res.ok) setCloseError(res.error ?? "关闭失败");
        // The provider process exits asynchronously after closeAgent persists
        // the snapshot — refresh once now and again shortly after.
        void query.refetch();
        setTimeout(() => void query.refetch(), 2000);
      })
      .catch((error) => setCloseError(error instanceof Error ? error.message : String(error)))
      .finally(() => setClosingPid(null));
  };
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
      nameLink: { color: theme.colors.accent, flex: 1, fontSize: 13 },
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
      closeButton: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
      },
      closeButtonText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      closeButtonConfirm: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      closeButtonConfirmText: { color: theme.colors.accentForeground, fontSize: 11 },
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
        {(data?.instances ?? []).map((instance) => {
          const agent = instance.agent;
          const agentLabel = agent?.title
            ? agent.title
            : instance.agentId
              ? `agent ${instance.agentId.slice(0, 8)}`
              : "未关联 agent";
          const metaParts: string[] = [];
          if (instance.agentId) metaParts.push(instance.agentId.slice(0, 7));
          if (agent) metaParts.push(agent.archivedAt ? "已归档" : agent.status);
          const age = instance.startedAt ? formatAge(instance.startedAt) : null;
          if (age) metaParts.push(`运行 ${age}`);
          if (instance.agentCwd) metaParts.push(instance.agentCwd);
          return (
            <View key={instance.pid}>
              <View style={styles.instanceRow}>
                {instance.agentId && navigation?.openAgent ? (
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={`打开 agent ${agentLabel}`}
                    style={{ flex: 1 }}
                    onPress={() => navigation.openAgent?.({ agentId: instance.agentId! })}
                  >
                    <Text style={styles.nameLink} numberOfLines={1}>
                      {agentLabel}
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={styles.name} numberOfLines={1}>
                    {agentLabel}
                  </Text>
                )}
                <Text style={styles.pid}>{instance.pid}</Text>
                <Text style={styles.mem}>{formatMb(instance.totalRssBytes)} MB</Text>
                {instance.agentId ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={confirmPid === instance.pid ? "确认关闭" : "关闭"}
                    disabled={closingPid === instance.pid}
                    style={[
                      styles.closeButton,
                      confirmPid === instance.pid ? styles.closeButtonConfirm : null,
                    ]}
                    onPress={() => handleClose(instance.pid, instance.agentId)}
                  >
                    <Text
                      style={
                        confirmPid === instance.pid
                          ? styles.closeButtonConfirmText
                          : styles.closeButtonText
                      }
                    >
                      {closingPid === instance.pid
                        ? "…"
                        : confirmPid === instance.pid
                          ? "确认?"
                          : "关闭"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {metaParts.length > 0 ? (
                <Text style={styles.command} numberOfLines={1}>
                  {metaParts.join(" · ")}
                </Text>
              ) : null}
              <Text style={styles.command} numberOfLines={1}>
                {instance.command}
              </Text>
              {instance.children.map((child) => (
                <Text key={child.pid} style={styles.childRow} numberOfLines={1}>
                  └ {child.name} {child.pid} {formatMb(child.rssBytes)} MB
                </Text>
              ))}
            </View>
          );
        })}
        {data && data.instances.length === 0 ? (
          <Text style={styles.mutedText}>当前没有运行中的 devin 进程。</Text>
        ) : null}
        {closeError ? <Text style={styles.mutedText}>关闭失败:{closeError}</Text> : null}
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
