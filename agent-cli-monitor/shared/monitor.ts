import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const childProcess = z.object({
  pid: z.number(),
  name: z.string(),
  rssBytes: z.number(),
});

const cliInstance = z.object({
  pid: z.number(),
  rssBytes: z.number(),
  command: z.string(),
  children: z.array(childProcess),
  totalRssBytes: z.number(),
});

const agentSession = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  status: z.string(),
  cwd: z.string().nullable(),
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
