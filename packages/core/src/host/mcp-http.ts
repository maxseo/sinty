import { z, type ToolDefinition } from "@sinty/sdk";
import type { InitMessage } from "./protocol.js";

interface Rpc {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

/** Talks to one MCP server over HTTP (JSON-RPC POST) and registers its tools. */
export async function connectMcpHttp(init: InitMessage, register: (tool: ToolDefinition) => void): Promise<() => void> {
  const url = init.manifest.url;
  if (!url) throw new Error("http plugin needs url");
  let session = "";
  let seq = 0;

  const rpc = async (method: string, params?: unknown, notify = false): Promise<unknown> => {
    const id = notify ? undefined : ++seq;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) session = sid;
    if (notify) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (!res.ok) throw new Error(`mcp http ${res.status}`);
    const text = await res.text();
    const msg = parseRpc(text, id!);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  };

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sinty", version: "1.0" } });
  await rpc("notifications/initialized", {}, true);
  const listed = (await rpc("tools/list", {})) as { tools?: { name: string; description?: string }[] };
  for (const tool of listed.tools ?? []) {
    register({
      name: `${init.manifest.name}.${tool.name}`,
      description: tool.description ?? tool.name,
      input: z.record(z.string(), z.unknown()),
      sideEffects: "external",
      idempotent: false,
      async run(args) {
        const result = (await rpc("tools/call", { name: tool.name, arguments: args ?? {} })) as { isError?: boolean; content?: { text?: string }[] };
        const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
        if (result.isError) throw new Error(text || "mcp tool failed");
        return { content: text || result };
      },
    });
  }
  return () => undefined;
}

function parseRpc(text: string, id: number): Rpc {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Rpc;
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const msg = JSON.parse(payload) as Rpc;
    if (msg.id === id || msg.id === undefined) return msg;
  }
  throw new Error("mcp http response had no JSON");
}
