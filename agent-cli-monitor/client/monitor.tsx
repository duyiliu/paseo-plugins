import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { monitorCloseAgent, monitorSnapshot, type MonitorSnapshot } from "../shared/monitor";

export const MONITOR_QUERY_KEY = ["agent-cli-monitor.snapshot"];

// Rows are about finding the heavy hitters, not listing every process.
const TOP_PROCESSES = 6;

// Idle rows past this threshold (and not running) are flagged as safe to close.
const IDLE_CLOSE_HOURS = 12;

export function formatMb(bytes: number): string {
  return (bytes / 1048576).toFixed(0);
}

export function formatGb(bytes: number): string {
  return (bytes / 1073741824).toFixed(1);
}

// Group totals are big enough that MB gets unreadable; rows keep MB precision.
export function formatBytes(bytes: number): string {
  return bytes >= 1073741824 ? `${formatGb(bytes)} GB` : `${formatMb(bytes)} MB`;
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

function formatLastUsed(iso: string): string | null {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
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
  const [closingAgentId, setClosingAgentId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const pollTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const timer of pollTimers.current) clearTimeout(timer);
    },
    [],
  );

  // The provider exits asynchronously after closeAgent persists the snapshot.
  // Poll with a widening delay and stop as soon as the instance disappears.
  const pollClosed = (agentId: string, attempt = 0) => {
    const delays = [1_000, 2_000, 4_000];
    if (attempt >= delays.length) return;
    const timer = setTimeout(() => {
      void query.refetch().then((result) => {
        const stillRunning = result.data?.instances.some((item) => item.agentId === agentId);
        if (stillRunning) pollClosed(agentId, attempt + 1);
      });
    }, delays[attempt]);
    pollTimers.current.push(timer);
  };

  const handleClose = (agentId: string) => {
    if (closingAgentId === agentId) return;
    setClosingAgentId(agentId);
    setCloseError(null);
    void closeAgent({ agentId })
      .then((res) => {
        if (!res.ok) setCloseError(res.error ?? "关闭失败");
        void query.refetch();
        pollClosed(agentId);
      })
      .catch((error) => setCloseError(error instanceof Error ? error.message : String(error)))
      .finally(() => setClosingAgentId(null));
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
      groupBlock: { paddingTop: compact ? 10 : 14 },
      groupHeader: {
        gap: 2,
        paddingBottom: 5,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        marginBottom: 2,
      },
      groupTitleRow: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        gap: 8,
      },
      wsName: {
        color: theme.colors.foreground,
        fontSize: compact ? 15 : 16,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      groupMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      groupMem: {
        color: theme.colors.foreground,
        fontSize: 13,
        marginLeft: "auto" as const,
        textAlign: "right" as const,
        fontVariant: ["tabular-nums" as const],
      },
      instanceBlock: {
        paddingVertical: compact ? 6 : 8,
        paddingLeft: 10,
        gap: 3,
      },
      titleBlock: { gap: 2 },
      name: { color: theme.colors.foreground, fontSize: compact ? 13 : 14 },
      nameLink: { color: theme.colors.accent, fontSize: compact ? 13 : 14 },
      metricsRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11, flex: 1, minWidth: 0 },
      memDim: { color: theme.colors.foregroundMuted },
      mem: {
        color: theme.colors.foreground,
        fontSize: 13,
        minWidth: compact ? 104 : 132,
        textAlign: "right" as const,
        fontVariant: ["tabular-nums" as const],
      },
      command: { color: theme.colors.foregroundMuted, fontSize: 11 },
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
      idleBadge: { color: theme.colors.statusWarning, fontSize: 11 },
      closeButtonIdle: { borderColor: theme.colors.statusWarning },
      closeButtonIdleText: { color: theme.colors.statusWarning },
      processRow: { color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: 18 },
      mutedText: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, compact],
  );

  const statusSummary = data?.agents
    ? Object.entries(data.agents.byStatus)
        .map(([status, count]) => `${status} ${count}`)
        .join(" · ")
    : null;

  // Group instances by workspace, the parent level in Paseo's sidebar, and
  // total each group. Groups and their rows both follow commit usage so the
  // heaviest workspace stays on top.
  const groups = useMemo(() => {
    type Instances = MonitorSnapshot["instances"];
    const byWorkspace = new Map<
      string,
      {
        key: string;
        workspaceId: string | null;
        title: string;
        instances: Instances;
        rssBytes: number;
        privateBytes: number | null;
        lastUserMessageAt: string | null;
        lastActivityAt: string | null;
      }
    >();
    for (const instance of data?.instances ?? []) {
      const workspaceId = instance.agent?.workspaceId ?? null;
      const key = workspaceId ?? "__unassigned__";
      let group = byWorkspace.get(key);
      if (!group) {
        group = {
          key,
          workspaceId,
          title: workspaceId
            ? (instance.agent?.workspaceTitle ?? `workspace ${workspaceId.slice(0, 8)}`)
            : "未归属 workspace",
          instances: [],
          rssBytes: 0,
          privateBytes: 0,
          lastUserMessageAt: null,
          lastActivityAt: null,
        };
        byWorkspace.set(key, group);
      }
      group.instances.push(instance);
      group.rssBytes += instance.totalRssBytes;
      group.privateBytes =
        group.privateBytes != null && instance.totalPrivateBytes != null
          ? group.privateBytes + instance.totalPrivateBytes
          : null;
      const userMessageAt = instance.agent?.lastUserMessageAt ?? null;
      if (
        userMessageAt &&
        (group.lastUserMessageAt == null || Date.parse(userMessageAt) > Date.parse(group.lastUserMessageAt))
      ) {
        group.lastUserMessageAt = userMessageAt;
      }
      const activityAt = instance.agent?.lastActivityAt ?? null;
      if (activityAt && (group.lastActivityAt == null || Date.parse(activityAt) > Date.parse(group.lastActivityAt))) {
        group.lastActivityAt = activityAt;
      }
    }
    return [...byWorkspace.values()].sort(
      (a, b) => (b.privateBytes ?? b.rssBytes) - (a.privateBytes ?? a.rssBytes),
    );
  }, [data]);

  return (
    <View style={styles.screen}>
      <View style={styles.statsRow}>
        <View>
          <Text style={styles.statValue}>
            {data?.system
              ? `${formatGb(data.system.committedBytes)} / ${formatGb(data.system.commitLimitBytes)}`
              : "…"}
          </Text>
          <Text style={styles.statLabel}>
            {data?.system
              ? `GB 系统已提交(${Math.round((data.system.committedBytes / data.system.commitLimitBytes) * 100)}%)`
              : "GB 系统已提交"}
          </Text>
        </View>
        <View>
          <Text style={styles.statValue}>{data ? `${groups.length} / ${data.instanceCount}` : "…"}</Text>
          <Text style={styles.statLabel}>workspace / 实例</Text>
        </View>
        <View>
          <Text style={styles.statValue}>
            {data ? (
              data.totalPrivateBytes != null ? (
                <>
                  <Text style={styles.memDim}>{formatMb(data.totalRssBytes)} / </Text>
                  {formatMb(data.totalPrivateBytes)}
                </>
              ) : (
                formatMb(data.totalRssBytes)
              )
            ) : (
              "…"
            )}
          </Text>
          <Text style={styles.statLabel}>MB 总内存(工作集/提交)</Text>
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

      <Text style={styles.sectionTitle}>实例明细（按 workspace 分组,内存=工作集/提交）</Text>
      <ScrollView style={{ flex: 1 }}>
        {groups.map((group) => {
          const workspaceId = group.workspaceId;
          const groupLastUsedAt = group.lastUserMessageAt ?? group.lastActivityAt;
          const groupLastUsed = groupLastUsedAt ? formatLastUsed(groupLastUsedAt) : null;
          const groupLastUsedLabel = group.lastUserMessageAt ? "最近使用" : "最近活动";
          const groupHeaderContent = (
            <>
              <View style={styles.groupTitleRow}>
                <Text style={styles.wsName} numberOfLines={1}>
                  {group.title}
                </Text>
                <Text style={styles.groupMem}>
                  {group.privateBytes != null ? (
                    <>
                      <Text style={styles.memDim}>{formatBytes(group.rssBytes)} / </Text>
                      {formatBytes(group.privateBytes)}
                    </>
                  ) : (
                    formatBytes(group.rssBytes)
                  )}
                </Text>
              </View>
              <Text style={styles.groupMeta} numberOfLines={1}>
                {`${group.instances.length} 个实例${groupLastUsed ? ` · ${groupLastUsedLabel} ${groupLastUsed}` : ""}`}
              </Text>
            </>
          );
          return (
            <View key={group.key} style={styles.groupBlock}>
              {workspaceId && navigation?.openWorkspace ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`打开 workspace ${group.title}`}
                  style={styles.groupHeader}
                  onPress={() => navigation.openWorkspace?.({ workspaceId })}
                >
                  {groupHeaderContent}
                </Pressable>
              ) : (
                <View style={styles.groupHeader}>{groupHeaderContent}</View>
              )}
              {group.instances.map((instance) => {
                const agent = instance.agent;
                const sessionLabel = agent?.title ? agent.title : `agent ${instance.agentId.slice(0, 8)}`;
                const agentLabel = `${group.title} → ${sessionLabel}`;
                const metaParts: string[] = [`${instance.processCount} 个进程`];
                if (agent) metaParts.push(agent.archivedAt ? "已归档" : agent.status);
                const age = instance.startedAt ? formatAge(instance.startedAt) : null;
                if (age) metaParts.push(`运行 ${age}`);
                const lastUsedAt = agent?.lastUserMessageAt ?? agent?.lastActivityAt ?? null;
                const lastUsed = lastUsedAt ? formatLastUsed(lastUsedAt) : null;
                if (lastUsed) metaParts.push(`${agent?.lastUserMessageAt ? "最近使用" : "最近活动"} ${lastUsed}`);
                const idleHours = agent?.lastUserMessageAt
                  ? (Date.now() - Date.parse(agent.lastUserMessageAt)) / 3600000
                  : null;
                const canClose =
                  agent != null &&
                  agent.status !== "running" &&
                  (agent.archivedAt != null || (idleHours != null && idleHours >= IDLE_CLOSE_HOURS));
                metaParts.push(instance.agentId.slice(0, 7));
                if (instance.agentCwd) metaParts.push(instance.agentCwd);
                const topProcesses = instance.processes.slice(0, TOP_PROCESSES);
                const sessionTitle = (
                  <Text style={navigation?.openAgent ? styles.nameLink : styles.name} numberOfLines={2}>
                    {sessionLabel}
                  </Text>
                );
                return (
                  <View key={instance.agentId} style={styles.instanceBlock}>
                    {navigation?.openAgent ? (
                      <Pressable
                        accessibilityRole="link"
                        accessibilityLabel={`打开 agent ${agentLabel}`}
                        style={styles.titleBlock}
                        onPress={() => navigation.openAgent?.({ agentId: instance.agentId })}
                      >
                        {sessionTitle}
                      </Pressable>
                    ) : (
                      <View style={styles.titleBlock}>{sessionTitle}</View>
                    )}
                    <View style={styles.metricsRow}>
                      <Text style={styles.meta} numberOfLines={1}>
                        {metaParts.join(" · ")}
                      </Text>
                      <Text style={styles.mem}>
                        {instance.totalPrivateBytes != null ? (
                          <>
                            <Text style={styles.memDim}>{formatMb(instance.totalRssBytes)} / </Text>
                            {formatMb(instance.totalPrivateBytes)} MB
                          </>
                        ) : (
                          `${formatMb(instance.totalRssBytes)} MB`
                        )}
                      </Text>
                      {canClose ? <Text style={styles.idleBadge}>可关闭</Text> : null}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`关闭 agent ${agentLabel}`}
                        disabled={closingAgentId === instance.agentId}
                        style={[styles.closeButton, canClose ? styles.closeButtonIdle : null]}
                        onPress={() => handleClose(instance.agentId)}
                      >
                        <Text style={[styles.closeButtonText, canClose ? styles.closeButtonIdleText : null]}>
                          {closingAgentId === instance.agentId ? "…" : "关闭 agent"}
                        </Text>
                      </Pressable>
                    </View>
                    <Text style={styles.command} numberOfLines={1}>
                      {instance.command}
                    </Text>
                    {topProcesses.map((proc) => (
                      <Text key={proc.pid} style={styles.processRow} numberOfLines={1}>
                        {proc.pid === instance.pid ? "▸" : "·"} {proc.name} {proc.pid} {formatMb(proc.rssBytes)} MB
                      </Text>
                    ))}
                    {instance.processCount > topProcesses.length ? (
                      <Text style={styles.processRow} numberOfLines={1}>
                        … 还有 {instance.processCount - topProcesses.length} 个进程
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          );
        })}
        {data && data.instances.length === 0 ? (
          <Text style={styles.mutedText}>当前没有运行中的 agent CLI 进程。</Text>
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
