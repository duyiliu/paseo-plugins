import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const instanceProcess = z.object({
  pid: z.number(),
  name: z.string(),
  rssBytes: z.number(),
  privateBytes: z.number().nullable(),
  command: z.string(),
});

const agentSession = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  status: z.string(),
  cwd: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceTitle: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  lastUserMessageAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});

const cliInstance = z.object({
  agentId: z.string(),
  agentCwd: z.string().nullable(),
  agent: agentSession.nullable(),
  pid: z.number(),
  name: z.string(),
  command: z.string(),
  startedAt: z.string().nullable(),
  processes: z.array(instanceProcess),
  processCount: z.number(),
  totalRssBytes: z.number(),
  totalPrivateBytes: z.number().nullable(),
});

export const monitorSnapshot = defineRpc({
  name: "monitor.snapshot",
  input: z.object({}),
  output: z.object({
    collectedAt: z.string(),
    platform: z.string(),
    instanceCount: z.number(),
    processCount: z.number(),
    totalRssBytes: z.number(),
    totalPrivateBytes: z.number().nullable(),
    system: z
      .object({
        committedBytes: z.number(),
        commitLimitBytes: z.number(),
      })
      .nullable(),
    instances: z.array(cliInstance),
    agents: z
      .object({
        total: z.number(),
        byStatus: z.record(z.string(), z.number()),
        items: z.array(agentSession),
      })
      .nullable(),
  }),
});

export type MonitorSnapshot = z.infer<typeof monitorSnapshot.output>;

export const monitorCloseAgent = defineRpc({
  name: "monitor.close_agent",
  input: z.object({
    agentId: z.string(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});
