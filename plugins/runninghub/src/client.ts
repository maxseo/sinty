import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const TERMINAL = new Set(["SUCCESS", "FAILED", "CANCEL"]);
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" };

export interface RhResult {
  taskId: string;
  status: string;
  outputs: { url: string; outputType: string }[];
  raw: unknown;
}

type FetchResponse = { ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> };
export type RhFetch = (url: string, init?: { method?: "GET" | "HEAD" | "POST"; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number; maxBytes?: number }) => Promise<FetchResponse>;

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function uploadFile(fetch: RhFetch, base: string, apiKey: string, filePath: string): Promise<string> {
  const bytes = new Uint8Array(readFileSync(filePath));
  const name = basename(filePath).replace(/"/g, "");
  const mime = MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
  const boundary = `rh${Date.now().toString(16)}`;
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const res = await fetch(joinUrl(base, "media/upload/binary"), {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
    timeoutMs: 60_000,
    maxBytes: 20_000_000,
  });
  const json = await readJson(res);
  const url = json && typeof json === "object" ? (json as { data?: { download_url?: string } }).data?.download_url : "";
  if (!url) throw new Error(messageOf(json) || "загрузка файла не вернула адрес");
  return url;
}

export async function submitTask(fetch: RhFetch, base: string, apiKey: string, endpoint: string, payload: Record<string, unknown>): Promise<string> {
  const res = await fetch(joinUrl(base, endpoint), {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 60_000,
  });
  const json = await readJson(res);
  const taskId = json && typeof json === "object" ? String((json as { taskId?: string; task_id?: string }).taskId || (json as { task_id?: string }).task_id || "") : "";
  if (!taskId) throw new Error(messageOf(json) || `задача не создалась (${res.status})`);
  return taskId;
}

export async function queryTask(fetch: RhFetch, base: string, apiKey: string, taskId: string): Promise<{ status: string; raw: unknown }> {
  const res = await fetch(joinUrl(base, "query"), {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ taskId }),
    timeoutMs: 30_000,
  });
  const raw = await readJson(res);
  const status = raw && typeof raw === "object" && typeof (raw as { status?: string }).status === "string" ? (raw as { status: string }).status : "";
  return { status, raw };
}

export function outputsOf(raw: unknown): { url: string; outputType: string }[] {
  const results = raw && typeof raw === "object" ? (raw as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) return [];
  const out: { url: string; outputType: string }[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { url?: string; outputUrl?: string; text?: string; content?: string; output?: string; outputType?: string };
    const url = rec.url || rec.outputUrl || rec.text || rec.content || rec.output || "";
    if (url) out.push({ url, outputType: rec.outputType || "" });
  }
  return out;
}

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export async function pollTask(fetch: RhFetch, base: string, apiKey: string, taskId: string, opts: { intervalMs: number; timeoutMs: number; sleep?: (ms: number) => Promise<void> }): Promise<RhResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.timeoutMs;
  let last = "";
  let raw: unknown = {};
  while (Date.now() < deadline) {
    const step = await queryTask(fetch, base, apiKey, taskId);
    last = step.status;
    raw = step.raw;
    if (isTerminal(last)) return { taskId, status: last, outputs: outputsOf(raw), raw };
    await sleep(opts.intervalMs);
  }
  return { taskId, status: last || "TIMEOUT", outputs: [], raw };
}

async function readJson(res: FetchResponse): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function messageOf(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const rec = json as { message?: string; msg?: string; error?: string };
  return rec.message || rec.msg || rec.error || "";
}
