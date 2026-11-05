import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { definePlugin, ToolError, z, type PluginContext, type TranscriptSegment } from "@sinty/sdk";
import { isAudioMime, resolveMime } from "./mime.ts";
import { resolveAudioPath } from "./path.ts";
import { readSettings, type SttSettings } from "./settings.ts";

function isRouteMissing(e: unknown): boolean {
  return e instanceof ToolError && e.code === "route_missing";
}

async function transcribe(
  ctx: PluginContext,
  s: SttSettings,
  file: { data: string; mime: string; filename: string },
  language: string,
  prompt: string | undefined,
  sessionId: string,
): Promise<{ text: string; route: string; provider: string; model: string; language?: string; durationSec?: number; segments?: TranscriptSegment[] }> {
  const route = s.modelRoute || "stt";
  const req = {
    route,
    data: file.data,
    mime: file.mime,
    filename: file.filename,
    ...(language ? { language } : {}),
    ...(prompt ? { prompt } : {}),
    sessionId,
  };
  try {
    const r = await ctx.models.transcribe(req);
    return { text: r.text, route, provider: r.provider, model: r.model, ...(r.language ? { language: r.language } : {}), ...(r.durationSec !== undefined ? { durationSec: r.durationSec } : {}), ...(r.segments?.length ? { segments: r.segments } : {}) };
  } catch (e) {
    if (e instanceof ToolError && isRouteMissing(e)) {
      throw new ToolError("route_missing", "no speech model is set", {
        hint: "Set models.routes.stt to an openai-compat speech model, for example openai/whisper-1, or fill Settings → STT.",
      });
    }
    if (e instanceof ToolError) throw e;
    throw new ToolError("stt_failed", e instanceof Error ? e.message : String(e), {
      hint: "The route must be an openai-compat server with POST /audio/transcriptions. A chat model such as deepseek-flash does not transcribe.",
    });
  }
}

export default definePlugin({
  name: "tool-stt",
  setup(ctx) {
    const s = readSettings(ctx.config);
    const skills = ctx.paths.skills;
    const globalWorkspace = ctx.paths.workspace;

    ctx.tool({
      name: "stt.transcribe",
      description:
        "Transcribe one or more audio files under the workspace (or skills:…) and return the spoken text with timed phrases. Each phrase has start and end in seconds, words when the model sends them, and a speaker label when the model tells voices apart. Writes the same JSON under the project _out/stt. Accepts mp3, wav, m4a, flac, ogg, webm and mp4. Do not use fs.read on audio. Needs models.routes.stt (or Settings → STT), for example openai/whisper-1. A diarize model fills speaker; whisper-1 fills word times.",
      input: z
        .object({
          path: z.string().min(1).optional().describe('One file, relative to the workspace, or "skills:<path>"'),
          paths: z.array(z.string().min(1)).min(1).max(20).optional().describe("Several files. Each is transcribed on its own."),
          language: z.string().regex(/^[a-z]{2}$/).optional().describe("ISO-639-1, for example ru. Overrides the Settings language for this call."),
          prompt: z.string().max(800).optional().describe("Hint for names and spellings. Applied to every file."),
        })
        .refine((v) => Boolean(v.path) || (v.paths && v.paths.length > 0), { message: "path or paths is required" }),
      sideEffects: "external",
      idempotent: true,
      timeoutMs: 900_000,
      async run({ path, paths, language, prompt }, run) {
        const wanted: string[] = [];
        for (const p of [...(path ? [path] : []), ...(paths ?? [])]) {
          if (!wanted.includes(p)) wanted.push(p);
        }
        const lang = language ?? s.language;
        const clips: { path: string; mime: string; bytes: number; text: string; file?: string; words: number; speakers: string[]; segments: TranscriptSegment[]; language?: string; durationSec?: number }[] = [];
        let route = "";
        let provider = "";
        let model = "";
        for (const one of wanted) {
          const { abs, shown } = resolveAudioPath(one, { workspace: run.workspace ?? globalWorkspace, skills });
          const info = await stat(abs).catch(() => undefined);
          if (!info) throw new ToolError("not_found", `${shown} does not exist`, { hint: "Use fs.list to see what is there." });
          if (info.isDirectory()) throw new ToolError("is_directory", `${shown} is a directory`, { hint: "Pass a file path to an audio clip." });
          if (info.size > s.maxBytes) {
            throw new ToolError("too_large", `${shown} is ${info.size} bytes (limit ${s.maxBytes})`, {
              hint: "Trim the clip or raise plugins.config.tool-stt.maxAudioMb (max 25).",
            });
          }
          const bytes = await readFile(abs);
          const mime = resolveMime(shown, bytes);
          if (!mime || !isAudioMime(mime)) {
            throw new ToolError("not_audio", `${shown} is not a supported audio file (got ${mime ?? "unknown"})`, {
              hint: "Supported: mp3, wav, m4a, flac, ogg, webm, mp4.",
            });
          }
          run.progress({ message: `transcribing ${shown}` });
          const result = await transcribe(ctx, s, { data: bytes.toString("base64"), mime, filename: basename(abs) }, lang, prompt, run.sessionId);
          route = result.route;
          provider = result.provider;
          model = result.model;
          const segments = result.segments ?? [];
          const speakers = [...new Set(segments.map((seg) => seg.speaker).filter((name): name is string => Boolean(name)))];
          const words = segments.reduce((n, seg) => n + seg.words.length, 0);
          const file = writeTranscript(run.workspace ?? globalWorkspace, shown, {
            path: shown,
            text: result.text,
            ...(result.language ? { language: result.language } : {}),
            ...(result.durationSec !== undefined ? { durationSec: result.durationSec } : {}),
            segments,
          });
          clips.push({
            path: shown,
            mime,
            bytes: bytes.byteLength,
            text: result.text,
            ...(file ? { file } : {}),
            words,
            speakers,
            segments,
            ...(result.language ? { language: result.language } : {}),
            ...(result.durationSec !== undefined ? { durationSec: result.durationSec } : {}),
          });
        }
        const text = clips.length === 1 ? clips[0]!.text : clips.map((c) => `${c.path}\n${c.text}`).join("\n\n");
        const first = clips[0]!;
        return {
          content: {
            ...(clips.length === 1 ? { path: first.path, mime: first.mime, bytes: first.bytes } : {}),
            count: clips.length,
            ...(lang ? { language: lang } : {}),
            route,
            provider,
            model,
            clips,
            text,
          },
        };
      },
    });
  },
});

/** The same timed transcript as a file the agent can search. A skills: path is not written into the skills folder. */
function writeTranscript(workspace: string, shown: string, body: unknown): string | undefined {
  if (!workspace || shown.startsWith("skills:")) return undefined;
  const stem = basename(shown).replace(/\.[^.]+$/, "").replace(/[^\w.-]+/gu, "_").slice(0, 80) || "clip";
  const dir = join(workspace, "_out", "stt");
  mkdirSync(dir, { recursive: true });
  const name = `${stem}.json`;
  writeFileSync(join(dir, name), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return `_out/stt/${name}`;
}
