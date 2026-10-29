import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Mark {
  version: string;
  sha: string;
}

export interface Remote {
  version: string;
  sha: string;
  date: string;
  title: string;
}

export function updateAvailable(seen: Mark | null, remote: Remote): boolean {
  if (!seen) return false;
  return seen.version !== remote.version || seen.sha !== remote.sha;
}

export function readMark(dir: string): Mark | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")) as Partial<Mark>;
    if (!parsed.version || !parsed.sha) return null;
    return { version: parsed.version, sha: parsed.sha };
  } catch {
    return null;
  }
}

export function writeMark(dir: string, mark: Mark): void {
  writeFileSync(join(dir, "seen.json"), JSON.stringify(mark));
}
