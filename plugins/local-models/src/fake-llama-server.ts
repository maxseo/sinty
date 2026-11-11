/** Test fixture: pretends to be llama-server. Only used when SINTY_LOCAL_MODELS_TEST=1. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

if (process.argv.includes("--version")) {
  process.stdout.write("fake-llama-server 0.0-test\n");
  process.exit(0);
}

const port = Number(arg("--port", "0"));
const host = arg("--host", "127.0.0.1");
const keyFile = arg("--api-key-file");
const fail = process.env.FAKE_LLAMA_FAIL === "1";
const delay = Number(process.env.FAKE_LLAMA_LOAD_MS ?? "50");
const apiKey = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const started = Date.now();

function authorized(req: IncomingMessage): boolean {
  if (!apiKey) return true;
  const h = req.headers.authorization ?? "";
  return h === `Bearer ${apiKey}` || h === apiKey;
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unauthorized" } }));
    return;
  }
  if (req.url === "/health" || req.url === "/v1/health") {
    if (fail) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "forced" } }));
      return;
    }
    if (Date.now() - started < delay) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 503, message: "Loading model", type: "unavailable_error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, host, () => {
  const addr = server.address();
  if (addr && typeof addr !== "string") process.stdout.write(`listening ${addr.port}\n`);
});

const halt = (): void => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGTERM", halt);
process.on("SIGINT", halt);
