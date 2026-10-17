import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const childProcess = z.object({
  pid: z.number(),
  name: z.string(),
  rssBytes: z.number(),
});

const agentSession = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  status: z.string(),
  cwd: z.string().nullable(),
  archivedAt: z.string().nullable(),
});

const cliInstance = z.object({
  pid: z.number(),
  rssBytes: z.number(),
  command: z.string(),
  agentId: z.string().nullable(),
  agentCwd: z.string().nullable(),
  agent: agentSession.nullable(),
  children: z.array(childProcess),
  totalRssBytes: z.number(),
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
