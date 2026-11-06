import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { definePlugin, ToolError, z } from "@sinty/sdk";

const BASE = "https://www.runninghub.ai/openapi/v2";

function pluginRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function apiKey(ctx: any): Promise<string> {
  const bag: any = ctx?.secrets;
  const tries: Array<() => Promise<any> | any> = [];
  if (bag && typeof bag.get === "function") tries.push(() => bag.get("runninghub"));
  if (bag && typeof bag.named === "function") tries.push(() => bag.named("runninghub"));
  if (bag && typeof bag.read === "function") tries.push(() => bag.read("runninghub"));
  if (typeof bag === "function") tries.push(() => bag("runninghub"));
  if (typeof ctx?.secret === "function") tries.push(() => ctx.secret("runninghub"));
  if (typeof ctx?.getSecret === "function") tries.push(() => ctx.getSecret("runninghub"));
  for (const t of tries) {
    try {
      const v = await t();
      if (typeof v === "string" && v.length > 8) return v;
      if (v && typeof v.value === "string") return v.value;
    } catch {
      /* next shape */
    }
  }
  const env = process.env.RUNNINGHUB_API_KEY;
  if (env) return env;
  throw new ToolError("rhany_key", "не нашёл ключ runninghub в секретах");
}

function dataRoot(ctx: any): string {
  const dir = ctx?.paths?.data ?? (ctx as any)?.paths?.DATA;
  if (!dir) throw new ToolError("rhany_path", "не знаю папку данных");
  return String(dir);
}

function rootsOf(ctx: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  };
  const paths = ctx?.paths ?? {};
  for (const v of Object.values(paths)) push(v);
  push(paths.data);
  push(paths.plugin);
  push(paths.PLUGIN);
  try {
    push(pluginRoot());
  } catch {
    /* import.meta may be odd in tests */
  }
  try {
    push(cwd());
  } catch {
    /* no cwd */
  }
  return out;
}

function findByBase(root: string, name: string, depth = 0): string | null {
  if (depth > 6) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry === basename(name)) {
      const hit = join(root, entry);
      try {
        if (!statSync(hit).isDirectory()) return hit;
      } catch {
        /* skip */
      }
    }
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (statSync(dir).isDirectory()) {
        const hit = findByBase(dir, name, depth + 1);
        if (hit) return hit;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

function locate(ctx: any, p: string): string {
  const notes: string[] = [];
  for (const root of rootsOf(ctx)) {
    const direct = isAbsolute(p) ? p : resolve(root, p);
    const rel = relative(root, direct);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      try {
        if (statSync(direct).isFile()) return direct;
        notes.push(`${root}: not a file`);
      } catch (error) {
        notes.push(`${root}: ${error instanceof Error ? error.message : "err"}`);
      }
    }
    const found = findByBase(root, basename(p));
    if (found) return found;
  }
  throw new ToolError("rhany_path", `файл ${p} не найден (${notes.join(" | ")})`);
}

function decodeB64(file: string, dest: string): string {
  const text = readFileSync(file, "utf8")
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s/g, "");
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length) throw new ToolError("rhany_blob", `пустой base64 ${file}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  return dest;
}

function materialize(ctx: any, p: string): string {
  const file = locate(ctx, p);
  if (!file.toLowerCase().endsWith(".b64")) return file;
  const dest = join(dataRoot(ctx), "in", basename(file).replace(/\.b64$/i, ".webp"));
  return decodeB64(file, dest);
}

async function materializeFromSession(ctx: any, tool: any, p: string): Promise<string> {
  if (typeof tool?.readSessionFile !== "function") {
    throw new ToolError("rhany_path", `файл ${p} не найден (нет session root)`);
  }
  const bytes = await tool.readSessionFile(p);
  const safe = basename(p).replace(/[^a-zA-Z0-9._-]/g, "_") || "ref.bin";
  const dest = join(dataRoot(ctx), "in", safe);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  if (!dest.toLowerCase().endsWith(".b64")) return dest;
  return decodeB64(dest, dest.replace(/\.b64$/i, ".webp"));
}

async function materializeArg(ctx: any, tool: any, p: string): Promise<string> {
  try {
    return materialize(ctx, p);
  } catch (first) {
    try {
      return await materializeFromSession(ctx, tool, p);
    } catch (sessionErr) {
      const a = first instanceof Error ? first.message : "err";
      const b = sessionErr instanceof Error ? sessionErr.message : "err";
      throw new ToolError("rhany_path", `файл ${p} не найден (${a}; session: ${b})`);
    }
  }
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function appendUrl(body: Record<string, any>, field: string, url: string) {
  if (field.endsWith("Urls") || Array.isArray(body[field])) {
    body[field] = [...(Array.isArray(body[field]) ? body[field] : []), url];
  } else {
    body[field] = url;
  }
}

async function upload(key: string, file: string): Promise<string> {
  const bytes = readFileSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), basename(file));
  const res = await fetch(`${BASE}/media/upload/binary`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolError("rhany_upload", `загрузка не вернула json: ${text.slice(0, 200)}`);
  }
  const url = parsed?.data?.download_url ?? parsed?.data?.downloadUrl ?? parsed?.download_url;
  if (!url) throw new ToolError("rhany_upload", `нет download_url: ${text.slice(0, 300)}`);
  return url;
}

async function submit(key: string, endpoint: string, body: any): Promise<string> {
  const res = await fetch(`${BASE}/${endpoint.replace(/^\/+/, "")}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const sent: any = await res.json().catch(() => ({}));
  const taskId = sent?.taskId ?? sent?.data?.taskId ?? sent?.data?.task_id;
  if (!taskId) throw new ToolError("rhany_submit", `модель не приняла задачу: ${JSON.stringify(sent).slice(0, 400)}`);
  return String(taskId);
}

async function waitResult(key: string, taskId: string, ms: number): Promise<any> {
  const until = Date.now() + ms;
  let last: any = null;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${BASE}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    last = await res.json().catch(() => ({}));
    const status = last?.status ?? last?.data?.status;
    if (status === "SUCCESS" || status === "FAILED") return last;
  }
  throw new ToolError("rhany_timeout", `не дождался результата: ${JSON.stringify(last).slice(0, 300)}`);
}

function urlsOf(done: any): string[] {
  const list = done?.results ?? done?.data?.results ?? [];
  return (Array.isArray(list) ? list : [])
    .map((r: any) => (typeof r === "string" ? r : r?.url))
    .filter((u: any) => typeof u === "string" && u.startsWith("http"));
}

async function save(root: string, taskId: string, urls: string[]): Promise<{ files: string[]; note?: string }> {
  const dir = join(root, "rhany", "out", taskId);
  const files: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < urls.length; i += 1) {
      const res = await fetch(urls[i]!);
      if (!res.ok) throw new Error(`storage ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const png = (urls[i]!.split("?")[0] ?? "").toLowerCase().endsWith(".png");
      const file = join(dir, `${i}.${png ? "png" : "jpg"}`);
      writeFileSync(file, buf);
      files.push(relative(root, file));
    }
    return { files };
  } catch (error) {
    return { files, note: `download failed inside plugin (${error instanceof Error ? error.message : "error"}); use web.fetch_file on urls[0] into the project now — links expire ~24h` };
  }
}

export default definePlugin({
  name: "rhany",
  setup(ctx) {
    ctx.tool({
      name: "rhany.run",
      description:
        "Submit a RunningHub model by raw endpoint (example dola-Seedream-5.0-pro/image-to-image). Prefer payload.imageUrls as HTTPS refs. files resolve under the current session root (project _inbox), then $DATA or the plugin folder; .b64 under $DATA is decoded. blobs are inline base64. On SUCCESS web.fetch_file urls[0] into the project — result URLs expire ~24h.",
      sideEffects: "external",
      timeoutMs: 600_000,
      input: z.object({
        endpoint: z.string().min(3).max(200),
        payload: z.record(z.any()).default({}),
        files: z.array(z.object({ field: z.string().min(1), path: z.string().min(1) })).default([]),
        blobs: z
          .array(
            z.object({
              field: z.string().min(1),
              name: z.string().min(1).max(80),
              base64: z.string().min(8).max(12_000_000),
            }),
          )
          .max(10)
          .default([]),
        timeoutSeconds: z.number().min(10).max(600).default(300),
      }),
      async run(input, tool) {
        if (input.endpoint === "__paths") {
          return { content: { roots: rootsOf(ctx), paths: ctx?.paths ?? null, session: tool?.workspace ?? null } };
        }
        const root = dataRoot(ctx);
        const key = await apiKey(ctx);
        const body: Record<string, any> = { ...(input.payload as Record<string, any>) };
        for (const file of input.files) {
          appendUrl(body, file.field, await upload(key, await materializeArg(ctx, tool, file.path)));
        }
        if (input.blobs.length) {
          const inbox = join(root, "in");
          mkdirSync(inbox, { recursive: true });
          for (const blob of input.blobs) {
            const raw = blob.base64
              .replace(/-----BEGIN CERTIFICATE-----/g, "")
              .replace(/-----END CERTIFICATE-----/g, "")
              .replace(/^data:[^;]+;base64,/, "")
              .replace(/\s/g, "");
            const bytes = Buffer.from(raw, "base64");
            if (!bytes.length) throw new ToolError("rhany_blob", `пустой файл ${blob.name}`);
            const safe = basename(blob.name).replace(/[^a-zA-Z0-9._-]/g, "_") || "ref.bin";
            const file = join(inbox, `${Date.now()}-${safe}`);
            writeFileSync(file, bytes);
            appendUrl(body, blob.field, await upload(key, file));
          }
        }
        const taskId = await submit(key, input.endpoint, body);
        const done = await waitResult(key, taskId, input.timeoutSeconds * 1000);
        const status = done?.status ?? done?.data?.status;
        const urls = urlsOf(done);
        if (status !== "SUCCESS" || !urls.length) {
          throw new ToolError("rhany_result", `задача ${taskId}: ${JSON.stringify(done).slice(0, 400)}`);
        }
        const copy = await save(root, taskId, urls);
        const hint =
          copy.note ||
          (!copy.files.length
            ? "use web.fetch_file on urls[0] into the project now — result URLs expire ~24h"
            : "result URLs expire ~24h; prefer the project file in saved[]");
        return {
          content: {
            taskId,
            status,
            endpoint: input.endpoint,
            urls,
            saved: copy.files,
            note: hint,
          },
        };
      },
    });
  },
});

