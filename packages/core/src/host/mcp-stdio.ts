import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z, type ToolDefinition } from "@sinty/sdk";
import type { InitMessage } from "./protocol.js";

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Talks to one MCP server over stdio (Content-Length frames) and registers its tools. */
export async function connectMcp(init: InitMessage, register: (tool: ToolDefinition) => void): Promise<() => void> {
  const command = init.manifest.command;
  if (!command?.length) throw new Error("mcp-stdio plugin needs command");
  const child = spawn(command[0]!, command.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let seq = 0;
  let buf = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buf.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buf = buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) return;
      const body = buf.subarray(start, start + len).toString("utf8");
      buf = buf.subarray(start + len);
      let msg: Rpc;
      try {
        msg = JSON.parse(body) as Rpc;
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const waiter = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message));
        else waiter.resolve(msg.result);
      }
    }
  });
  const rpc = (method: string, params?: unknown): Promise<unknown> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
      child.stdin.write(payload);
    });
  };
  const close = (): void => {
    if (child.exitCode === null) child.kill();
  };
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("mcp server exited"));
    pending.clear();
  });

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sinty", version: "1.0" } });
  const note = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  child.stdin.write(`Content-Length: ${note.length}\r\n\r\n`);
  child.stdin.write(note);
  const listed = (await rpc("tools/list", {})) as { tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] };
  for (const tool of listed.tools ?? []) {
    const name = `${init.manifest.name}.${tool.name}`;
    register({
      name,
      description: tool.description ?? tool.name,
      input: z.record(z.string(), z.unknown()),
      sideEffects: "external",
      idempotent: false,
      async run(args) {
        const result = (await rpc("tools/call", { name: tool.name, arguments: args ?? {} })) as { isError?: boolean; content?: { type?: string; text?: string }[] };
        const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
        if (result.isError) throw new Error(text || "mcp tool failed");
        return { content: text || result };
      },
    });
  }
  return close;
}
