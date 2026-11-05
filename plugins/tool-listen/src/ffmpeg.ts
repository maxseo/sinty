import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AUDIO = new Set([".mp3", ".wav", ".m4a", ".mp4", ".mpeg", ".mpga", ".ogg", ".oga", ".webm", ".flac", ".aac", ".mov", ".mkv"]);

export function isMediaPath(path: string): boolean {
  const i = path.lastIndexOf(".");
  return i >= 0 && AUDIO.has(path.slice(i).toLowerCase());
}

/** The Sinty ffmpeg, then whatever is on PATH. */
export function ffmpegBin(): string {
  const local = process.env.LOCALAPPDATA;
  const dirs = local ? [join(local, "Sinty", "tools", "ffmpeg"), join(local, "Sinty", "tools")] : [];
  for (const dir of dirs) {
    const direct = join(dir, "ffmpeg.exe");
    if (existsSync(direct)) return direct;
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const nested = join(dir, name, "bin", "ffmpeg.exe");
      if (existsSync(nested)) return nested;
    }
  }
  return "ffmpeg";
}

/** One mono 16 kHz mp3 of the file, or of [start, end) when those seconds are given. */
export function extractMp3(input: string, outFile: string, start?: number, end?: number): Promise<void> {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (start !== undefined && start > 0) args.push("-ss", String(start));
  if (end !== undefined) args.push("-to", String(end));
  args.push("-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", outFile);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { windowsHide: true });
    let err = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      err += String(chunk);
      if (err.length > 4000) err = err.slice(-4000);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}
