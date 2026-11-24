import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ToolError, z, type ToolDefinition } from "@sinty/sdk";
import type { InitMessage } from "./protocol.js";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_HEADER = 8192;

/** Legacy framing stays the default. Standard MCP servers opt into config.stdioTransport="ndjson". */
export async function connectMcp(init: InitMessage, register: (tool: ToolDefinition) => void, onClose?: (close: () => void) => void): Promise<() => void> {
  const command = init.manifest.command;
  if (!command?.length) throw new Error("mcp-stdio plugin needs command");
  const transport = init.config.stdioTransport ?? "content-length";
  if (transport !== "content-length" && transport !== "ndjson") throw new Error("stdioTransport must be content-length or ndjson");
  const requestMs = init.config.stdioRequestTimeoutMs ?? 120_000;
  if (typeof requestMs !== "number" || !Number.isInteger(requestMs) || requestMs < 10 || requestMs > 300_000) throw new Error("stdioRequestTimeoutMs must be an integer from 10 to 300000");
  // Optional env values are secret:// refs, resolved by the host, never printed here.
  const childEnv = { ...process.env };
  const envMap = init.config.env;
  if (envMap && typeof envMap === "object" && !Array.isArray(envMap)) {
    for (const [key, ref] of Object.entries(envMap as Record<string, unknown>)) {
      if (typeof ref !== "string") continue;
      const m = /^secret:\/\/(.+)$/.exec(ref.trim());
      if (!m) continue;
      const v = init.secrets[m[1]!];
      if (v !== undefined) childEnv[key] = v;
    }
  }
  const child = spawn(command[0]!, command.slice(1), {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: childEnv, cwd: init.paths.plugin,
  }) as ChildProcessWithoutNullStreams;
  type Waiter = { resolve(v: unknown): void; reject(e: Error): void; cleanup(): void };
  const pending = new Map<number, Waiter>();
  let seq = 0, buf = Buffer.alloc(0), closed = false, stderrBytes = 0;
  // Drain diagnostics without forwarding possibly sensitive stderr into prompts or errors.
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.length); });
  const close = (reason = new Error("mcp connection closed")): void => {
    if (closed) return;
    closed = true;
    buf = Buffer.alloc(0);
    for (const waiter of pending.values()) { waiter.cleanup(); waiter.reject(reason); }
    pending.clear();
    child.stdin.destroy();
    if (child.exitCode === null) child.kill();
  };
  onClose?.(() => close());
  const write = (msg: Rpc): void => {
    if (closed) throw new Error("mcp connection closed");
    const payload = Buffer.from(JSON.stringify(msg));
    if (payload.length > MAX_MESSAGE) throw new Error("mcp outgoing message exceeds 16 MiB");
    const frame = transport === "ndjson" ? Buffer.concat([payload, Buffer.from("\n")]) : Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload]);
    child.stdin.write(frame, (error) => { if (error) close(error); });
  };
  const receive = (body: Buffer): void => {
    let msg: Rpc;
    try {
      const value: unknown = JSON.parse(body.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as Rpc).jsonrpc !== "2.0") throw new Error();
      msg = value as Rpc;
    } catch { throw new Error("mcp sent invalid JSON-RPC"); }
    // A server request must not be mistaken for a response with the same numeric id.
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, ...(msg.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Client method not supported" } }) });
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiter = pending.get(msg.id);
    if (!waiter) return; // Late/cancelled replies are ignored.
    if (("result" in msg) === (msg.error !== undefined)) throw new Error("mcp response must have exactly one result or error");
    pending.delete(msg.id); waiter.cleanup();
    if (msg.error) waiter.reject(new Error(String(msg.error.message ?? "mcp request failed")));
    else waiter.resolve(msg.result);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    try {
      // One read may finish a maximal frame and include the start of the next.
      if (buf.length + chunk.length > MAX_MESSAGE + MAX_HEADER + 65_536) throw new Error("mcp receive buffer exceeds bounded message capacity");
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (transport === "ndjson") {
          const end = buf.indexOf(10);
          if (end < 0) { if (buf.length > MAX_MESSAGE) throw new Error("mcp message exceeds 16 MiB"); break; }
          if (end > MAX_MESSAGE) throw new Error("mcp message exceeds 16 MiB");
          const body = buf.subarray(0, end); buf = buf.subarray(end + 1);
          if (!body.length || (body.length === 1 && body[0] === 13)) throw new Error("mcp sent an empty message");
          receive(body);
        } else {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) { if (buf.length > MAX_HEADER) throw new Error("mcp header exceeds 8 KiB"); break; }
          if (end > MAX_HEADER) throw new Error("mcp header exceeds 8 KiB");
          const lengths = buf.subarray(0, end).toString("ascii").split("\r\n").filter((line) => /^content-length:/i.test(line));
          if (lengths.length !== 1 || !/^content-length:\s*\d+\s*$/i.test(lengths[0]!)) throw new Error("mcp sent invalid Content-Length");
          const length = Number(lengths[0]!.split(":")[1]!.trim());
          if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MESSAGE) throw new Error("mcp message size is invalid or exceeds 16 MiB");
          const start = end + 4;
          if (buf.length < start + length) break;
          const body = buf.subarray(start, start + length); buf = buf.subarray(start + length);
          receive(body);
        }
      }
    } catch (error) { close(error instanceof Error ? error : new Error("mcp protocol error")); }
  });
  child.on("error", (error) => close(error));
  child.stdin.on("error", (error) => close(error));
  child.on("exit", (code) => close(new Error(`mcp server exited (${code ?? "signal"}; ${stderrBytes} stderr bytes)`)));
  const rpc = (method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("mcp connection closed"));
    if (pending.size >= 128) return Promise.reject(new Error("mcp has too many pending requests"));
    if (signal?.aborted) return Promise.reject(new ToolError("aborted", "mcp request cancelled"));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const cancel = (error: Error): void => {
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id); waiter.cleanup();
        try { write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Request cancelled" } }); } catch { /* connection already closed */ }
        reject(error);
      };
      const onAbort = (): void => cancel(new ToolError("aborted", "mcp request cancelled"));
      const timer = setTimeout(() => cancel(new ToolError("timeout", `mcp ${method} timed out`)), method === "tools/call" ? requestMs : Math.min(requestMs, 10_000));
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      try { write({ jsonrpc: "2.0", id, method, params }); } catch (error) { pending.delete(id); cleanup(); reject(error); }
    });
  };
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sinty", version: "1.0" } });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    type ListedTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
    const listed: ListedTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = (await rpc("tools/list", cursor ? { cursor } : {})) as { tools?: ListedTool[]; nextCursor?: unknown };
      if (!Array.isArray(page?.tools) || listed.length + page.tools.length > 4096) throw new Error("mcp tools/list exceeds the bounded tools array");
      listed.push(...page.tools);
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      if (page.nextCursor !== undefined && !cursor) throw new Error("mcp tools/list returned an invalid cursor");
      if (cursor) {
        if (cursors.has(cursor) || cursors.size >= 32 || cursor.length > 4096) throw new Error("mcp tools/list pagination exceeds bounds");
        cursors.add(cursor);
      }
    } while (cursor);
    const names = new Set<string>();
    // Convert before registering anything: unsupported/external refs fail closed, never become arbitrary arguments.
    const definitions = listed.map((tool): ToolDefinition => {
      if (!tool || typeof tool.name !== "string" || !tool.name || tool.name.length > 300) throw new Error("mcp returned an invalid tool name");
      if (names.has(tool.name)) throw new Error("mcp returned a duplicate tool name");
      names.add(tool.name);
      if (tool.description !== undefined && typeof tool.description !== "string") throw new Error("mcp returned an invalid tool description");
      const input = z.fromJSONSchema((tool.inputSchema ?? { type: "object", additionalProperties: true }) as Parameters<typeof z.fromJSONSchema>[0]);
      return {
        name: `${init.manifest.name}.${tool.name}`, description: tool.description ?? tool.name, input,
        sideEffects: "external", idempotent: false, timeoutMs: requestMs,
        async run(args, ctx) {
          const result = (await rpc("tools/call", { name: tool.name, arguments: args ?? {} }, ctx.signal)) as { isError?: boolean; content?: { type?: string; text?: string }[]; structuredContent?: unknown };
          if (!result || typeof result !== "object") throw new Error("mcp tools/call returned an invalid result");
          const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
          if (result.isError) throw new Error(text || "mcp tool failed");
          // Preserve mixed/image/structured results. Text-only legacy tools still return a plain string.
          const structured = result.structuredContent !== undefined || (result.content ?? []).some((c) => c.type !== "text" && c.type !== undefined);
          return { content: structured ? result : text || result };
        },
      };
    });
    for (const def of definitions) register(def);
    return () => close();
  } catch (error) { close(); throw error; }
}
