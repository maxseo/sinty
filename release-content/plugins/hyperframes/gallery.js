import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
};
/** Title and stage size written into a HyperFrames HTML file. */
export function compositionMeta(html) {
    const id = /data-composition-id\s*=\s*"([^"]*)"/i.exec(html)?.[1]?.trim() ?? "";
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    const width = Number(/data-width\s*=\s*"(\d+)"/i.exec(html)?.[1] ?? 0);
    const height = Number(/data-height\s*=\s*"(\d+)"/i.exec(html)?.[1] ?? 0);
    return { id, title, width: Number.isFinite(width) ? width : 0, height: Number.isFinite(height) ? height : 0 };
}
/** True when `target` is a file or folder inside `root`, not the root itself. */
export function insideDir(root, target) {
    const rel = relative(resolve(root), resolve(target));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
export function compositionRoot(workspace) {
    return join(workspace, "hyperframes");
}
export function listSlugs(workspace) {
    const root = compositionRoot(workspace);
    if (!existsSync(root))
        return [];
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SLUG.test(entry.name) && existsSync(join(root, entry.name, "index.html")))
        .map((entry) => entry.name)
        .sort();
}
export function findVideo(dir) {
    if (!existsSync(dir))
        return "";
    const name = readdirSync(dir).find((file) => file.toLowerCase().endsWith(".mp4"));
    return name ? join(dir, name) : "";
}
export function findFfmpeg() {
    const local = process.env.LOCALAPPDATA ?? "";
    const tools = join(local, "Sinty", "tools");
    const candidates = [join(tools, "ffmpeg", "ffmpeg.exe"), join(tools, "ffmpeg", "bin", "ffmpeg.exe"), join(tools, "ffmpeg.exe")];
    if (existsSync(tools)) {
        for (const name of readdirSync(tools)) {
            candidates.push(join(tools, name, "bin", "ffmpeg.exe"));
            candidates.push(join(tools, name, "ffmpeg.exe"));
        }
    }
    for (const path of candidates) {
        if (existsSync(path))
            return path;
    }
    return "ffmpeg";
}
/** One small JPEG for the card. Reused until the video or the HTML is newer. */
export function ensureThumb(dir, ffmpeg) {
    const thumb = join(dir, "thumb.jpg");
    const video = findVideo(dir);
    const html = join(dir, "index.html");
    const source = video || firstImage(dir) || html;
    if (!existsSync(source))
        return "";
    try {
        if (existsSync(thumb) && statSync(thumb).mtimeMs >= statSync(source).mtimeMs && statSync(thumb).size > 0)
            return thumb;
    }
    catch {
        /* make a new one */
    }
    if (!video && !firstImage(dir))
        return "";
    const input = video || firstImage(dir);
    const child = spawnSync(ffmpeg, ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-ss", "0.2", "-i", input, "-frames:v", "1", "-vf", "scale=320:-2", thumb], {
        windowsHide: true,
        timeout: 20_000,
    });
    if (child.status === 0 && existsSync(thumb))
        return thumb;
    return "";
}
function firstImage(dir) {
    const name = readdirSync(dir).find((file) => file.toLowerCase() !== "thumb.jpg" && IMAGE[extname(file).toLowerCase()]);
    return name ? join(dir, name) : "";
}
/** Rewrites relative images in the composition so a preview can show them without the folder. */
export function inlineAssets(dir, html, maxBytes = 2_000_000) {
    const root = resolve(dir);
    return html.replace(/(src|poster)\s*=\s*(["'])([^"']+)\2/gi, (whole, attr, quote, url) => {
        if (/^(https?:|data:|blob:|#|\/)/i.test(url))
            return whole;
        const file = resolve(root, url.split("?")[0] ?? "");
        if (!insideDir(root, file))
            return whole;
        const mime = IMAGE[extname(file).toLowerCase()];
        if (!mime || !existsSync(file))
            return whole;
        const buf = readFileSync(file);
        if (buf.length > maxBytes)
            return whole;
        return `${attr}=${quote}data:${mime};base64,${buf.toString("base64")}${quote}`;
    });
}
export function installedVersion(prefix) {
    try {
        const pkg = JSON.parse(readFileSync(join(prefix, "node_modules", "hyperframes", "package.json"), "utf8"));
        return pkg.version ?? "";
    }
    catch {
        return "";
    }
}
export function localCli(prefix) {
    const name = process.platform === "win32" ? "hyperframes.cmd" : "hyperframes";
    const bin = join(prefix, "node_modules", ".bin", name);
    return existsSync(bin) ? bin : "";
}
//# sourceMappingURL=gallery.js.map