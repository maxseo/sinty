import { stdin, stdout } from "node:process";

let buf = Buffer.alloc(0);
stdin.on("data", (chunk) => {
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
    const msg = JSON.parse(buf.subarray(start, start + len).toString("utf8"));
    buf = buf.subarray(start + len);
    if (msg.method === "notifications/initialized") continue;
    let result = {};
    if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "echo", version: "0" } };
    if (msg.method === "tools/list") {
      result = { tools: [{ name: "ping", description: "echo the text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
    }
    if (msg.method === "tools/call") result = { content: [{ type: "text", text: String(msg.params?.arguments?.text ?? "") }] };
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdout.write(body);
  }
});
