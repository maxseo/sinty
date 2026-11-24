import { definePlugin, parseSSE, ToolError, z, type ChatMessage, type ProviderChunk, type ProviderRequest, type TranscriptSegment, type TranscriptWord, openAIModelList } from "@sinty/sdk";

import { CompatibleToolNames } from "./tool-call-names.js";

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
  candidates?: Set<string>;
}

export default definePlugin({
  name: "provider-openai-compat",
  setup(ctx) {
    ctx.provider({
      protocol: "openai-compat",
      async *stream(req) {
        const compatible = toolCallNameMode(req) === "catalog-compatible";
        const names = compatible ? new CompatibleToolNames(req.tools.map(tool => tool.name)) : undefined;
        if (names && !names.valid) throw new ToolError("provider_error", "Duplicate or invalid advertised tool names");
        const baseUrl = (req.endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const res = await ctx.net.fetch(`${baseUrl}/chat/completions`, {
          method: "POST", signal: req.signal,
          headers: { "content-type": "application/json", ...(req.endpoint.apiKey ? { authorization: `Bearer ${req.endpoint.apiKey}` } : {}), ...req.endpoint.headers },
          body: JSON.stringify(buildBody(req)),
        });
        if (!res.ok || !res.body) throw await httpError(res);
        const calls = new Map<number, ToolCallAcc>();
        let finish = "stop";
        let issue: string | undefined;
        let usage = { inputTokens: 0, outputTokens: 0 } as Extract<ProviderChunk, { type: "done" }>["usage"];
        for await (const msg of parseSSE(res.body, req.signal)) {
          if (msg.data === "[DONE]") break;
          const chunk = JSON.parse(msg.data) as ChatChunk;
          if (chunk.error) throw new ToolError("provider_error", chunk.error.message ?? "stream error");
          if (chunk.usage) usage = usageOf(chunk.usage);
          for (const choice of chunk.choices ?? []) {
            // ProviderChunk has no choice channel. Unsupported alternatives are rejected, never merged.
            if (compatible && ((chunk.choices?.length ?? 0) > 1 || choice.index !== 0)) issue ??= "unsupported_tool_choices";
            const d = choice.delta ?? {};
            const reasoning = d.reasoning_content ?? d.reasoning;
            if (reasoning) yield { type: "reasoning", text: reasoning };
            if (d.content) yield { type: "text", text: d.content };
            if (compatible && !Array.isArray(d.tool_calls ?? [])) { issue ??= "invalid_tool_metadata"; continue; }
            for (const tc of d.tool_calls ?? []) {
              if (compatible && issue) continue; // Still drain the response for final usage, never dispatch partial calls.
              if (compatible && (!tc || typeof tc !== "object")) { issue = "invalid_tool_metadata"; continue; }
              const acc: ToolCallAcc = calls.get(tc.index) ?? { id: "", name: "", args: "", ...(compatible ? { candidates: new Set([""]) } : {}) };
              if (compatible) {
                if (!Number.isInteger(tc.index) || tc.index < 0 || (tc.id !== undefined && (typeof tc.id !== "string" || !tc.id))) { issue = "invalid_tool_metadata"; continue; }
                if (tc.id && ((acc.id && acc.id !== tc.id) || [...calls].some(([index, call]) => index !== tc.index && call.id === tc.id))) { issue = "tool_identity_conflict"; continue; }
                const field = tc.function?.name;
                if (field !== undefined && field !== "") {
                  if (typeof field !== "string") { issue = "invalid_tool_metadata"; continue; }
                  acc.candidates = names!.advance(acc.candidates!, field);
                  if (!acc.candidates.size) { issue = "incomplete_or_unknown_tool_name"; continue; }
                }
                if (tc.function?.arguments !== undefined && typeof tc.function.arguments !== "string") { issue = "invalid_tool_metadata"; continue; }
              } else if (tc.function?.name) acc.name += tc.function.name;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.arguments) acc.args += tc.function.arguments; // Always argument deltas, including equal fragments.
              calls.set(tc.index, acc);
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        }
        if (compatible) for (const acc of calls.values()) {
          const resolved = names!.resolve(acc.candidates!);
          issue ??= !acc.id ? "incomplete_tool_identity" : resolved.issue;
          if (resolved.name) acc.name = resolved.name;
        }
        if (issue) {
          // A visible LOCAL adapter refusal, not a fabricated upstream answer. Accept reported usage and end the turn,
          // rather than throw away paid usage or trigger the core's transport fallback. No tool_call is emitted.
          yield { type: "text", text: `

[Sinty adapter error: ${issue}. Tool calls were not executed.]` };
          yield { type: "done", stopReason: "stop", usage };
          return;
        }
        for (const acc of [...calls.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)) {
          yield { type: "tool_call", id: acc.id, name: acc.name, args: parseArgs(acc.args) };
        }
        yield { type: "done", stopReason: finish, usage };
      },
      async listModels(endpoint) {
        const baseUrl = (endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const res = await ctx.net.fetch(`${baseUrl}/models`, { headers: { ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}), ...endpoint.headers } });
        if (!res.ok) throw await httpError(res);
        return openAIModelList(await res.json());
      },
      /** POST {baseUrl}/embeddings (OpenAI-compatible). Vectors are returned in input order. */
      async embed(req) {
        const baseUrl = (req.endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const res = await ctx.net.fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          signal: req.signal,
          headers: {
            "content-type": "application/json",
            ...(req.endpoint.apiKey ? { authorization: `Bearer ${req.endpoint.apiKey}` } : {}),
            ...req.endpoint.headers,
          },
          body: JSON.stringify({ model: req.model, input: req.input }),
        });
        if (!res.ok) throw await httpError(res);
        const body = (await res.json()) as { data?: { index?: number; embedding?: number[] }[]; usage?: { prompt_tokens?: number } };
        const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== req.input.length || rows.some((r) => !Array.isArray(r.embedding))) {
          throw new ToolError("provider_error", `embeddings answer has ${rows.length} vectors for ${req.input.length} inputs`);
        }
        return { vectors: rows.map((r) => r.embedding!), ...(body.usage?.prompt_tokens !== undefined ? { usage: { inputTokens: body.usage.prompt_tokens } } : {}) };
      },
      /** POST {baseUrl}/audio/transcriptions (OpenAI Whisper and compatible servers). */
      async transcribe(req) {
        const baseUrl = (req.endpoint.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const bytes = Buffer.from(req.data, "base64");
        const timed = req.model.includes("diarize") ? "diarized_json" : "verbose_json";
        const post = (format: string, granular: boolean) => {
          const form = new FormData();
          form.append("file", new Blob([bytes], { type: req.mime }), req.filename);
          form.append("model", req.model);
          form.append("response_format", format);
          if (granular) {
            form.append("timestamp_granularities[]", "segment");
            form.append("timestamp_granularities[]", "word");
          }
          if (req.language) form.append("language", req.language);
          if (req.prompt) form.append("prompt", req.prompt);
          return ctx.net.fetch(`${baseUrl}/audio/transcriptions`, {
            method: "POST",
            signal: req.signal,
            headers: {
              ...(req.endpoint.apiKey ? { authorization: `Bearer ${req.endpoint.apiKey}` } : {}),
              ...req.endpoint.headers,
            },
            body: form,
          });
        };
        let res = await post(timed, timed === "verbose_json");
        if (!res.ok && (res.status === 400 || res.status === 415 || res.status === 422)) {
          await res.arrayBuffer().catch(() => undefined);
          res = await post("json", false);
        }
        if (!res.ok) throw await httpError(res);
        return transcriptionOf(await res.json(), bytes.byteLength);
      },
    });
  },
});

/**
 * `options.promptCacheKey` (Sinty's own option, never sent as is): `true` sends `prompt_cache_key` (the core's
 * per-session `cacheKey`), `false` never does. Unset: only for api.openai.com, because some compatible servers reject
 * unknown fields. DeepSeek caches prefixes on its own and needs no key.
 */
/** The JSON body of `POST /audio/transcriptions`. An empty `text` is silence, not a failure. */
export function transcriptionOf(body: unknown, bytes: number): { text: string; segments?: TranscriptSegment[]; language?: string; durationSec?: number; usage: { inputTokens: number; outputTokens: number } } {
  const row = body && typeof body === "object" ? (body as { text?: unknown; language?: unknown; duration?: unknown; error?: { message?: unknown } }) : {};
  if (row.error && typeof row.error.message === "string") throw new ToolError("provider_error", row.error.message);
  const segments = segmentsOf(row);
  const text = typeof row.text === "string" ? row.text.trim() : segments?.map((s) => s.text).join(" ").trim();
  if (typeof text !== "string") throw new ToolError("provider_error", "transcription answer has no text");
  const language = typeof row.language === "string" && row.language ? row.language : undefined;
  const durationSec = typeof row.duration === "number" && Number.isFinite(row.duration) ? row.duration : undefined;
  const usage = { inputTokens: Math.max(1, Math.ceil(bytes / 1000)), outputTokens: Math.ceil(text.length / 4) };
  return { text, ...(segments ? { segments } : {}), ...(language ? { language } : {}), ...(durationSec !== undefined ? { durationSec } : {}), usage };
}

function wordOf(raw: unknown): TranscriptWord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as { word?: unknown; text?: unknown; start?: unknown; end?: unknown };
  const text = (typeof row.word === "string" ? row.word : typeof row.text === "string" ? row.text : "").trim();
  const start = typeof row.start === "number" && Number.isFinite(row.start) ? row.start : undefined;
  const end = typeof row.end === "number" && Number.isFinite(row.end) ? row.end : undefined;
  if (!text || start === undefined || end === undefined) return undefined;
  return { text, start, end };
}

/** Timed phrases from verbose_json or diarized_json. Words at the top level are placed into the phrase that contains them. */
export function segmentsOf(body: object): TranscriptSegment[] | undefined {
  const row = body as { segments?: unknown; words?: unknown };
  const loose = Array.isArray(row.words) ? row.words.map(wordOf).filter((w): w is TranscriptWord => Boolean(w)) : [];
  if (!Array.isArray(row.segments)) {
    if (!loose.length) return undefined;
    return [{ text: loose.map((w) => w.text).join(" "), start: loose[0]!.start, end: loose[loose.length - 1]!.end, words: loose }];
  }
  const segments: TranscriptSegment[] = [];
  for (const raw of row.segments) {
    if (!raw || typeof raw !== "object") continue;
    const seg = raw as { text?: unknown; start?: unknown; end?: unknown; speaker?: unknown; words?: unknown };
    const start = typeof seg.start === "number" && Number.isFinite(seg.start) ? seg.start : 0;
    const end = typeof seg.end === "number" && Number.isFinite(seg.end) ? seg.end : start;
    const own = Array.isArray(seg.words) ? seg.words.map(wordOf).filter((w): w is TranscriptWord => Boolean(w)) : loose.filter((w) => w.start >= start - 0.02 && w.start < end + 0.02);
    const text = (typeof seg.text === "string" ? seg.text : own.map((w) => w.text).join(" ")).trim();
    const speaker = typeof seg.speaker === "string" && seg.speaker.trim() ? seg.speaker.trim() : undefined;
    if (!text && !own.length) continue;
    segments.push({ text, start, end, ...(speaker ? { speaker } : {}), words: own });
  }
  return segments.length ? segments : undefined;
}

/** Provider-wide adapter contract, independent of upstream model IDs. Never sent upstream. */
function toolCallNameMode(req: ProviderRequest): "delta" | "catalog-compatible" {
  const parsed = z.enum(["delta", "catalog-compatible"]).safeParse(req.endpoint.options?.toolCallNameMode ?? "delta");
  if (!parsed.success) throw new ToolError("provider_error", "Invalid local toolCallNameMode configuration");
  return parsed.data;
}

export function buildBody(req: ProviderRequest): Record<string, unknown> {
  const { promptCacheKey, toolCallNameMode: _toolCallNameMode, toolCallNameModes: _removedModelModes, ...options } = req.endpoint.options ?? {};
  const baseUrl = req.endpoint.baseUrl ?? "https://api.openai.com/v1";
  const sendKey = promptCacheKey === true || (promptCacheKey === undefined && /^https:\/\/api\.openai\.com(\/|$)/.test(baseUrl));
  const omni = /omni/i.test(req.model);
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: req.messages.map((message) => toWireMessage(message, omni)),
    ...(sendKey && req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
    ...(omni && req.messages.some((message) => message.audio?.length) ? { modalities: ["text"] } : {}),
    ...options,
  };
  if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens;
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  }
  const deepseek = /api\.deepseek\.com(\/|$)/.test(baseUrl);
  if (req.reasoning === "off") {
    if (deepseek) body.thinking = { type: "disabled" };
  } else if (req.reasoning) {
    body.reasoning_effort = req.reasoning;
    if (deepseek) body.thinking = { type: "enabled" };
  }
  return body;
}

function toWireMessage(m: ChatMessage, audioUri = false): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
    };
  }
  if (m.images?.length || m.audio?.length) {
    return {
      role: m.role,
      content: [
        { type: "text", text: m.content },
        ...(m.images ?? []).map((img) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } })),
        ...(m.audio ?? []).map((clip) => ({
          type: "input_audio",
          input_audio: { data: audioUri ? `data:;base64,${clip.data}` : clip.data, format: clip.mime.includes("wav") ? "wav" : "mp3" },
        })),
      ],
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * Usage from the final chunk. Prompt cache: DeepSeek reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * (and sometimes also `prompt_tokens_details.cached_tokens`); OpenAI reports `prompt_tokens_details.cached_tokens`.
 */
export function usageOf(u: NonNullable<ChatChunk["usage"]>): Extract<ProviderChunk, { type: "done" }>["usage"] {
  const input = u.prompt_tokens ?? 0;
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
  const miss = u.prompt_cache_miss_tokens ?? (hit !== undefined ? Math.max(0, input - hit) : undefined);
  return {
    inputTokens: input,
    outputTokens: u.completion_tokens ?? 0,
    ...(hit ? { cachedTokens: hit } : {}),
    ...(miss !== undefined ? { cacheMissTokens: miss } : {}),
  };
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json: raw };
  }
}

async function httpError(res: Response): Promise<ToolError> {
  const text = await res.text().catch(() => "");
  const retryable = res.status === 429 || res.status >= 500;
  return new ToolError(`http_${res.status}`, text.slice(0, 1000) || res.statusText, {
    retryable,
    ...(res.status === 401 ? { hint: "Check the provider API key: sinty secret set <name>" } : {}),
  });
}

export interface ChatChunk {
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
  choices?: {
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}
