import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
const TERMINAL = new Set(["SUCCESS", "FAILED", "CANCEL"]);
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" };
export function joinUrl(base, path) {
    return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
export async function uploadFile(fetch, base, apiKey, filePath) {
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
    const url = json && typeof json === "object" ? json.data?.download_url : "";
    if (!url)
        throw new Error(messageOf(json) || "загрузка файла не вернула адрес");
    return url;
}
/** RunningHub puts `taskId` on the object or under `data`, and a refusal comes back as HTTP 200 with `errorMessage`. */
export function taskIdOf(json) {
    const rec = record(json);
    const data = record(rec.data);
    const id = text(rec.taskId) || text(rec.task_id) || text(data.taskId) || text(data.task_id);
    return id;
}
export function apiError(json) {
    const rec = record(json);
    const data = record(rec.data);
    const code = rec.errorCode ?? rec.error_code ?? data.errorCode ?? data.error_code;
    const failed = code !== undefined && code !== 0 && code !== "0" && code !== "";
    const msg = text(rec.errorMessage) || text(rec.error_message) || text(data.errorMessage) || text(data.error_message) || text(rec.message) || text(rec.error) || (failed ? text(rec.msg) || text(data.msg) : "");
    const codeStr = failed ? String(code) : "";
    return [codeStr && `код ${codeStr}`, msg].filter(Boolean).join(": ");
}
export async function submitTask(fetch, base, apiKey, endpoint, payload) {
    const res = await fetch(joinUrl(base, endpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 60_000,
    });
    const json = await readJson(res);
    const taskId = taskIdOf(json);
    if (!taskId)
        throw new Error(apiError(json) || messageOf(json) || `задача не создалась (${res.status})`);
    return taskId;
}
export async function queryTask(fetch, base, apiKey, taskId) {
    const res = await fetch(joinUrl(base, "query"), {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
        timeoutMs: 30_000,
    });
    const raw = await readJson(res);
    const flat = { ...record(raw), ...record(record(raw).data) };
    const status = text(flat.status);
    const err = apiError(raw);
    if (!status && err)
        throw new Error(err);
    return { status, raw };
}
export function outputsOf(raw) {
    const flat = { ...record(raw), ...record(record(raw).data) };
    const results = flat.results;
    if (!Array.isArray(results))
        return [];
    const out = [];
    for (const row of results) {
        if (!row || typeof row !== "object")
            continue;
        const rec = row;
        const url = rec.url || rec.outputUrl || rec.text || rec.content || rec.output || "";
        if (url)
            out.push({ url, outputType: rec.outputType || "" });
    }
    return out;
}
export function isTerminal(status) {
    return TERMINAL.has(status);
}
export async function pollTask(fetch, base, apiKey, taskId, opts) {
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + opts.timeoutMs;
    let last = "";
    let raw = {};
    while (Date.now() < deadline) {
        const step = await queryTask(fetch, base, apiKey, taskId);
        last = step.status;
        raw = step.raw;
        if (isTerminal(last))
            return { taskId, status: last, outputs: outputsOf(raw), raw };
        await sleep(opts.intervalMs);
    }
    return { taskId, status: last || "TIMEOUT", outputs: [], raw };
}
async function readJson(res) {
    const text = await res.text();
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        return { message: text.slice(0, 300) };
    }
}
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value) {
    return typeof value === "string" ? value : "";
}
function messageOf(json) {
    if (!json || typeof json !== "object")
        return "";
    const rec = json;
    return rec.message || rec.msg || rec.error || "";
}
//# sourceMappingURL=client.js.map