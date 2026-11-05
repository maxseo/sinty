import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileInRoot } from "./files.js";
import { definePlugin, ToolError, z } from "@sinty/sdk";
import { apiError, pollTask, submitTask, uploadFile, type RhFetch } from "./client.js";
import { moneyOf, openHistory } from "./history.js";
import { cardOf, modelByEndpoint, parseRegistry, searchModels, SEED, validatePayload, type RhModel, type RhRegistry } from "./registry.js";
import { tabHtml } from "./tab-page.js";

const TAB_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "media-src https: data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const DEFAULT_BASE = "https://www.runninghub.ai/openapi/v2";
const DEFAULT_REGISTRY = "https://raw.githubusercontent.com/HM-RunningHub/ComfyUI_RH_OpenAPI/main/developer-kit/model-registry.public.json";

function fileExt(kind: string, url: string, contentType: string): string {
  const fromType: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
  };
  const typed = fromType[contentType.split(";")[0]?.trim().toLowerCase() ?? ""];
  if (typed) return typed;
  const named = /\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|ogg)(?:$|\?)/i.exec(url);
  if (named?.[1]) return `.${named[1].toLowerCase().replace("jpeg", "jpg")}`;
  if (kind === "video") return ".mp4";
  if (kind === "audio") return ".mp3";
  return ".png";
}

export default definePlugin({
  name: "runninghub",
  setup(ctx) {
    const dataDir = ctx.paths.data;
    mkdirSync(dataDir, { recursive: true });
    const registryFile = join(dataDir, "registry.json");
    const history = openHistory(join(dataDir, "generations.db"));
    const settingsFile = join(dataDir, "settings.json");

    function baseUrl(): string {
      try {
        const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as { baseUrl?: string };
        if (saved.baseUrl) return saved.baseUrl.replace(/\/+$/, "");
      } catch { /* the yaml default applies */ }
      const configured = ctx.config.baseUrl;
      return (typeof configured === "string" && configured.trim() ? configured : DEFAULT_BASE).replace(/\/+$/, "");
    }

    let refreshOnce: Promise<void> | undefined;
    let registryError = "";

    /** The page used to stay on the two seed cards until a person pressed refresh, and the public file has no `id`. */
    async function ensureRegistry(): Promise<void> {
      if (existsSync(registryFile)) return;
      if (!refreshOnce) {
        refreshOnce = refreshRegistry()
          .then(() => { registryError = ""; })
          .catch((e: unknown) => { registryError = e instanceof Error ? e.message : "реестр не скачался"; })
          .finally(() => { refreshOnce = undefined; });
      }
      await refreshOnce;
    }

    function readRegistry(): { registry: RhRegistry; source: "registry" | "seed" } {
      try {
        return { registry: parseRegistry(JSON.parse(readFileSync(registryFile, "utf8"))), source: "registry" };
      } catch {
        return { registry: SEED, source: "seed" };
      }
    }

    async function refreshRegistry(): Promise<{ count: number; version: string }> {
      const configured = ctx.config.registryUrl;
      const url = typeof configured === "string" && configured.trim() ? configured : DEFAULT_REGISTRY;
      const res = await ctx.net.public.fetch(url, { timeoutMs: 60_000, maxBytes: 20_000_000 });
      if (!res.ok) throw new ToolError("runninghub_registry", `реестр ${res.status}`);
      const parsed = parseRegistry(JSON.parse(await res.text()));
      if (!parsed.models.length) throw new ToolError("runninghub_registry", "реестр пустой");
      writeFileSync(registryFile, JSON.stringify(parsed));
      return { count: parsed.models.length, version: parsed.version ?? "" };
    }

    async function apiKey(): Promise<string> {
      try {
        return await ctx.secrets.get("runninghub");
      } catch {
        throw new ToolError("runninghub_key", "ключ runninghub не задан", { hint: "Настройки → Модели → плашка runninghub, вставьте ключ Enterprise-Shared и сохраните." });
      }
    }

    const fetchRh: RhFetch = (url, init) => ctx.net.public.fetch(url, init);

    async function runModel(endpoint: string, payload: Record<string, unknown>, files: { field: string; path: string }[], destRoot: string): Promise<unknown> {
      await ensureRegistry();
      const started = Date.now();
      const model = modelByEndpoint(readRegistry().registry, endpoint);
      if (!model) throw new ToolError("runninghub_endpoint", `нет endpoint ${endpoint}`, { hint: "Сначала runninghub.search, потом runninghub.schema." });
      let taskId = "";
      let status = "failed";
      let error = "";
      let outputs: { url: string; outputType: string }[] = [];
      let raw: unknown = {};
      const saved: string[] = [];
      try {
        const key = await apiKey();
        const body: Record<string, unknown> = { ...payload };
        const grouped = new Map<string, string[]>();
        for (const file of files) {
          const abs = fileInRoot(destRoot, file.path) ?? fileInRoot(ctx.paths.workspace, file.path) ?? fileInRoot(dataDir, file.path);
          if (!abs) throw new ToolError("runninghub_path", `файл вне проекта: ${file.path}`);
          if (!existsSync(abs)) throw new ToolError("runninghub_path", `файл не найден: ${file.path}`);
          const url = await uploadFile(fetchRh, baseUrl(), key, abs);
          const list = grouped.get(file.field) ?? [];
          list.push(url);
          grouped.set(file.field, list);
        }
        for (const [field, urls] of grouped) {
          const param = (model.params ?? []).find((p) => p.fieldKey === field);
          body[field] = param?.multipleInputs || urls.length > 1 ? urls : urls[0];
        }
        const errors = validatePayload(model, body);
        if (errors.length) throw new ToolError("runninghub_payload", errors.map((e) => `${e.field}: ${e.message}`).join("; "));
        taskId = await submitTask(fetchRh, baseUrl(), key, endpoint, body);
        const kind = (model.output_type ?? "").toLowerCase();
        const timeoutMs = kind === "image" ? 180_000 : 1_200_000;
        const result = await pollTask(fetchRh, baseUrl(), key, taskId, { intervalMs: 5_000, timeoutMs });
        raw = result.raw;
        outputs = result.outputs;
        status = result.status === "SUCCESS" ? "success" : (result.status || "failed").toLowerCase();
        if (result.status !== "SUCCESS") {
          error = apiError(result.raw);
          throw new ToolError("runninghub_task", [`задача ${taskId}: ${result.status}`, error].filter(Boolean).join(" — "), { hint: "Статус можно посмотреть в Tasks & Billing RunningHub." });
        }
        const safeId = taskId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "task";
        const dir = join(destRoot, "_out", "generation", safeId);
        mkdirSync(dir, { recursive: true });
        for (const [i, output] of result.outputs.entries()) {
          if (!/^https?:\/\//i.test(output.url)) continue;
          try {
            const res = await ctx.net.public.fetch(output.url, { timeoutMs: 60_000, maxBytes: 20_000_000 });
            if (!res.ok) continue;
            const ext = fileExt(kind, output.url, res.headers.get("content-type") ?? "");
            const file = join(dir, `${i}${ext}`);
            writeFileSync(file, Buffer.from(await res.arrayBuffer()));
            const rel = relative(destRoot, file).replace(/\\/g, "/");
            saved.push(rel.startsWith("..") ? file : rel);
          } catch {
            /* the url stays in the answer when the file host is outside the allow list or the file is large */
          }
        }
        return { taskId, status: result.status, outputs: result.outputs, files: saved };
      } catch (e) {
        if (!error) error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        const money = moneyOf(raw);
        history.add({
          taskId,
          endpoint,
          name: model.name_en || endpoint,
          status,
          startedAt: new Date(started).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          error,
          payload: JSON.stringify(payload),
          outputs: JSON.stringify(outputs),
          coins: money.coins,
          amount: money.amount,
          detail: JSON.stringify(raw),
        });
      }
    }

    ctx.tool({
      name: "runninghub.search",
      description: "Search RunningHub standard models (image, video, audio, 3d). Returns endpoint names. Text chat models are the runninghub provider in Settings → Models, not this tool.",
      input: z.object({ query: z.string().default(""), type: z.string().default("") }),
      sideEffects: "read",
      idempotent: true,
      async run(args) {
        await ensureRegistry();
        const { registry, source } = readRegistry();
        const items = searchModels(registry, args.query, args.type).map(cardOf);
        return { content: { source, count: registry.models.length, items } };
      },
    });

    ctx.tool({
      name: "runninghub.schema",
      description: "Exact parameter schema for one RunningHub endpoint from the local registry. Use only these field names and enum values.",
      input: z.object({ endpoint: z.string() }),
      sideEffects: "read",
      idempotent: true,
      async run(args) {
        await ensureRegistry();
        const model = modelByEndpoint(readRegistry().registry, args.endpoint);
        if (!model) throw new ToolError("runninghub_endpoint", `нет endpoint ${args.endpoint}`);
        return { content: { model } };
      },
    });

    ctx.tool({
      name: "runninghub.run",
      description: "Submit one RunningHub standard model and wait for the result. files are { field, path } inside the chat project; local paths are uploaded first. Image, video and audio URLs in the payload must already be remote addresses. Saved results are project-relative paths under _out/generation. The chat plays those files. Tell the user the result is ready and include each saved path; do not paste the remote URL.",
      input: z.object({
        endpoint: z.string(),
        payload: z.record(z.string(), z.unknown()).default({}),
        files: z.array(z.object({ field: z.string(), path: z.string() })).default([]),
      }),
      sideEffects: "external",
      timeoutMs: 1_200_000,
      idempotent: false,
      async run(args, tool) {
        await ensureRegistry();
        const root = tool.workspace || ctx.paths.workspace;
        return { content: await runModel(args.endpoint, args.payload, args.files, root) };
      },
    });

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    const fail = (message: string, status = 400): Response => json({ error: { message } }, status);
    const html = (): Response => new Response(tabHtml(), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": TAB_CSP, "cache-control": "no-store" } });

    ctx.http({ method: "GET", path: "/tab/catalog", public: true, surface: "catalog", handler: () => html() });
    ctx.http({
      method: "GET",
      path: "/status",
      surface: "settings",
      access: "view",
      handler: async () => {
        await ensureRegistry();
        const { registry, source } = readRegistry();
        let hasKey = false;
        try { await ctx.secrets.get("runninghub"); hasKey = true; } catch { /* the models card has no key yet */ }
        return json({ hasKey, baseUrl: baseUrl(), count: registry.models.length, version: registry.version ?? "", source, ...(registryError ? { registryError } : {}) });
      },
    });
    ctx.http({
      method: "GET",
      path: "/history",
      surface: "settings",
      access: "view",
      handler: () => json({ items: history.list() }),
    });
    ctx.http({
      method: "GET",
      path: "/search",
      surface: "settings",
      access: "view",
      handler: async (req) => {
        await ensureRegistry();
        const url = new URL(req.url);
        const { registry } = readRegistry();
        const requested = Number(url.searchParams.get("limit") ?? "1000");
        const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 1000) : 1000;
        const matched = searchModels(registry, url.searchParams.get("q") ?? "", url.searchParams.get("type") ?? "", 100000);
        return json({ items: matched.slice(0, limit).map(cardOf), total: matched.length });
      },
    });
    ctx.http({
      method: "GET",
      path: "/schema",
      surface: "settings",
      access: "view",
      handler: async (req) => {
        await ensureRegistry();
        const endpoint = new URL(req.url).searchParams.get("endpoint") ?? "";
        const model: RhModel | undefined = modelByEndpoint(readRegistry().registry, endpoint);
        if (!model) return fail("нет такого endpoint", 404);
        return json({ model });
      },
    });
    ctx.http({
      method: "POST",
      path: "/registry",
      surface: "settings",
      access: "edit",
      handler: async () => {
        try {
          return json(await refreshRegistry());
        } catch (e) {
          return fail(e instanceof Error ? e.message : "реестр не обновился", 502);
        }
      },
    });
    ctx.http({
      method: "POST",
      path: "/run",
      surface: "settings",
      access: "edit",
      handler: async (req) => {
        const body = await req.json() as { endpoint?: string; payload?: Record<string, unknown> };
        if (!body.endpoint) return fail("нужен endpoint");
        try {
          return json(await runModel(body.endpoint, body.payload ?? {}, [], dataDir));
        } catch (e) {
          return fail(e instanceof Error ? e.message : "запуск не прошёл", 502);
        }
      },
    });
  },
});
