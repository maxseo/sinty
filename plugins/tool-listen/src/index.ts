import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, ToolError, z, type PluginContext } from "@sinty/sdk";
import { extractMp3, isMediaPath } from "./ffmpeg.ts";
import { resolveMediaPath } from "./path.ts";
import { readSettings, type ListenSettings } from "./settings.ts";

const MAX_BYTES = 8_000_000;

async function ask(
  ctx: PluginContext,
  s: ListenSettings,
  audio: { mime: string; data: string },
  prompt: string,
  sessionId: string,
): Promise<{ text: string; route: string; provider: string; model: string }> {
  const route = s.modelRoute || "listen";
  try {
    const r = await ctx.models.complete({
      route,
      messages: [{ role: "user", content: prompt, audio: [audio] }],
      sessionId,
    });
    return { text: r.text, route, provider: r.provider, model: r.model };
  } catch (e) {
    if (e instanceof ToolError && e.code === "route_missing") {
      throw new ToolError("route_missing", "no audio model is set", {
        hint: "Set models.routes.listen to a chat model that accepts audio, for example a Gemini on OpenRouter. Speech-to-text stays on models.routes.stt.",
      });
    }
    if (e instanceof ToolError) throw e;
    throw new ToolError("listen_failed", e instanceof Error ? e.message : String(e), {
      hint: "The route must be an openai-compat chat model that accepts input_audio. A text-only model will refuse the clip.",
    });
  }
}

export default definePlugin({
  name: "tool-listen",
  setup(ctx) {
    const s = readSettings(ctx.config);
    const skills = ctx.paths.skills;
    const globalWorkspace = ctx.paths.workspace;

    ctx.tool({
      name: "audio.listen",
      description:
        "Ask a question about the sound of one audio or video file under the workspace (or skills:…). ffmpeg keeps the audio as a short mono mp3 and a chat model answers. Use it for what is happening in the sound: music, who is speaking, events, with times. For a word-for-word transcript with word times use stt.transcribe. For pictures use vision.look. Needs models.routes.listen, a model that accepts audio.",
      input: z.object({
        path: z.string().min(1).describe('File relative to the workspace, or "skills:<path>"'),
        prompt: z.string().min(1).max(2000).optional().describe("What to answer about the sound. Default: describe speech, music and events with approximate times."),
        start: z.number().min(0).optional().describe("Start of the window, in seconds."),
        end: z.number().min(0).optional().describe("End of the window, in seconds. A long file needs a window no longer than the Max length setting."),
      }),
      sideEffects: "external",
      idempotent: true,
      timeoutMs: 300_000,
      async run({ path, prompt, start, end }, run) {
        if (start !== undefined && end !== undefined && end <= start) {
          throw new ToolError("bad_window", `end (${end}) is not after start (${start})`);
        }
        const span = (end ?? Number.POSITIVE_INFINITY) - (start ?? 0);
        if (span > s.maxSeconds) {
          throw new ToolError("too_long", `the window is longer than ${s.maxSeconds} seconds`, {
            hint: "Pass start and end, in seconds, for the part you want heard.",
          });
        }
        const { abs, shown } = resolveMediaPath(path, { workspace: run.workspace ?? globalWorkspace, skills });
        const info = statSync(abs, { throwIfNoEntry: false });
        if (!info) throw new ToolError("not_found", `${shown} does not exist`, { hint: "Use fs.list to see what is there." });
        if (info.isDirectory()) throw new ToolError("is_directory", `${shown} is a directory`);
        if (!isMediaPath(shown)) {
          throw new ToolError("not_audio", `${shown} is not an audio or video file`, {
            hint: "Supported: mp3, wav, m4a, flac, ogg, aac, mp4, webm, mov, mkv.",
          });
        }
        const dir = join(ctx.paths.data, "tmp", randomUUID());
        mkdirSync(dir, { recursive: true });
        const out = join(dir, "clip.mp3");
        try {
          run.progress({ message: `listening to ${shown}` });
          await extractMp3(abs, out, start, end);
          const bytes = readFileSync(out);
          if (bytes.byteLength < 128) throw new ToolError("empty_audio", `${shown} has no audio in that window`);
          if (bytes.byteLength > MAX_BYTES) {
            throw new ToolError("too_large", `the clip is ${bytes.byteLength} bytes (limit ${MAX_BYTES})`, {
              hint: "Pass a shorter start and end.",
            });
          }
          const question = prompt?.trim() || "Describe what is heard: speech, music, who is speaking, and other sounds. Give approximate times in seconds from the start of this clip.";
          const result = await ask(ctx, s, { mime: "audio/mpeg", data: bytes.toString("base64") }, question, run.sessionId);
          return {
            content: {
              path: shown,
              bytes: bytes.byteLength,
              ...(start !== undefined ? { start } : {}),
              ...(end !== undefined ? { end } : {}),
              route: result.route,
              provider: result.provider,
              model: result.model,
              text: result.text,
            },
          };
        } catch (error) {
          if (error instanceof ToolError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (/ENOENT|not recognized|not found/i.test(message)) {
            throw new ToolError("ffmpeg_missing", "ffmpeg was not found", { hint: "Install ffmpeg next to Sinty under %LOCALAPPDATA%\\Sinty\\tools\\ffmpeg." });
          }
          throw new ToolError("listen_failed", message);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    });
  },
});
