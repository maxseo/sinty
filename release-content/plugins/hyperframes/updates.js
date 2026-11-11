import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function updateAvailable(seen, remote) {
    if (!seen)
        return false;
    return seen.version !== remote.version || seen.sha !== remote.sha;
}
export function readMark(dir) {
    try {
        const parsed = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
        if (!parsed.version || !parsed.sha)
            return null;
        return { version: parsed.version, sha: parsed.sha };
    }
    catch {
        return null;
    }
}
export function writeMark(dir, mark) {
    writeFileSync(join(dir, "seen.json"), JSON.stringify(mark));
}
//# sourceMappingURL=updates.js.map