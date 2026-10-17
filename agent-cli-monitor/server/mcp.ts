import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpEndpoint {
  agentId: string;
  url: string;
  token: string;
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

// The daemon injects a per-run capability token into each agent's persisted
// session config (persistence.metadata.mcpServers.paseo). Reading it back from
// the caller's own record lets the plugin call the daemon's /mcp/agents
// endpoint, which is the only path that reaches agentManager.closeAgent.
export async function readAgentMcpEndpoint(agentId: string): Promise<McpEndpoint | null> {
  const agentsRoot = join(paseoHome(), "agents");
  let dirs: string[];
  try {
    dirs = await readdir(agentsRoot);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(agentsRoot, dir, `${agentId}.json`), "utf8");
      const record = JSON.parse(raw) as {
        persistence?: {
          metadata?: {
            mcpServers?: {
              paseo?: { url?: string; headers?: { Authorization?: string } };
            };
          };
        };
      };
      const paseo = record.persistence?.metadata?.mcpServers?.paseo;
      const token = paseo?.headers?.Authorization?.replace(/^Bearer\s+/i, "");
      if (!paseo?.url || !token) return null;
      return { agentId, url: paseo.url, token };
    } catch {
      continue;
    }
  }
  return null;
}

interface JsonRpcPayload {
  error?: { message?: string } | null;
  result?: {
    isError?: boolean;
    content?: { type?: string; text?: string }[];
    structuredContent?: { success?: boolean };
  };
}

function parseMcpPayload(text: string): JsonRpcPayload | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as JsonRpcPayload;
    } catch {
      return null;
    }
  }
  // Streamable HTTP responses arrive as SSE `data:` frames.
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        return JSON.parse(line.slice(5).trim()) as JsonRpcPayload;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function callAgentMcpTool(
  endpoint: McpEndpoint,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null }> {
  const url = new URL(endpoint.url);
  url.searchParams.set("callerAgentId", endpoint.agentId);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  const text = await res.text();
  const payload = parseMcpPayload(text);
  if (!payload) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  if (payload.error) return { ok: false, error: payload.error.message ?? "MCP error" };
  const result = payload.result;
  if (result?.isError) {
    return { ok: false, error: result.content?.map((c) => c.text ?? "").join(" ") || "tool error" };
  }
  return { ok: result?.structuredContent?.success !== false, error: null };
}
