import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
export type UpdatePhase = "prepared" | "old_move_intent" | "new_move_intent" | "activate_intent" | "ready" | "commit_intent" | "committed" | "rolled_back" | "recovery_required";
export interface UpdateFlags {
    enabled: boolean;
    disabled: boolean;
}
export interface UpdateReceipt {
    version: string;
    previousVersion?: string;
    source: "path" | "npm" | "catalog";
    trust: "local-path-unverified" | "npm-registry-unverified" | "trusted-catalog";
    signatureVerified: boolean;
    publisher: string | null;
    artifactSha256?:string;catalogUrl?:string;catalogSequence?:number;signatureScope?:"catalog-index";
    changelog?: string;
}
export interface UpdateJournal {
    format: "sinty.plugin-update/1";
    id: string;
    pid: number;
    name: string;
    phase: UpdatePhase;
    created: string;
    updated: string;
    previousExisted: boolean;
    candidateHash: string;
    previousHash?: string;
    dataHash?: string;
    hasDataScope: boolean;
    configBefore?: UpdateFlags;
    configAfter?: UpdateFlags;
    metadata?: UpdateReceipt;
    reason?: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function syncText(file: string, text: string): void { const tmp = file + ".tmp-" + randomUUID(), fd = openSync(tmp, "wx", 0o600); try {
    writeFileSync(fd, text);
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} try {
    renameSync(tmp, file);
}
finally {
    if (existsSync(tmp))
        unlinkSync(tmp);
} try {
    const d = openSync(join(file, ".."), "r");
    try {
        fsyncSync(d);
    }
    finally {
        closeSync(d);
    }
}
catch { /* Directory flushing is not portable on Windows; not a power-loss guarantee. */ } }
export function syncJson(file: string, value: unknown): void { syncText(file, JSON.stringify(value, null, 2)); }
export function configPluginFlags(file: string, name: string): UpdateFlags { const d = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : ""); const has = (k: string): boolean => { const v = d.getIn(["plugins", k]); return !!v && typeof v === "object" && "toJSON" in v && ((v as {
    toJSON(): unknown;
}).toJSON() as string[]).includes(name); }; return { enabled: has("enabled"), disabled: has("disabled") }; }
export function packageFingerprint(root: string): string { if (!existsSync(root))
    return "absent"; const h = createHash("sha256"); let count = 0, bytes = 0; function walk(dir: string, depth: number): void { if (depth > 32)
    throw Error("fingerprint_limit"); const s = lstatSync(dir); if (s.isSymbolicLink())
    throw Error("fingerprint_link"); if (s.isDirectory()) {
    h.update(JSON.stringify(["D", relative(root, dir).split(sep).join("/")]) + "\0");
    for (const n of readdirSync(dir).sort())
        walk(join(dir, n), depth + 1);
}
else if (s.isFile()) {
    if (s.nlink > 1 || ++count > 20000 || (bytes += s.size) > 256 * 1024 * 1024)
        throw Error("fingerprint_limit");
    h.update(JSON.stringify(["F", relative(root, dir).split(sep).join("/"), s.size]) + "\0");
    h.update(createHash("sha256").update(readFileSync(dir)).digest());
}
else
    throw Error("fingerprint_entry"); } ; walk(root, 0); return h.digest("hex"); }
export function flushPackage(root: string): void { function walk(p: string): void { const s = lstatSync(p); if (s.isSymbolicLink() || s.isFile() && s.nlink > 1)
    throw Error("unsafe_flush_path"); if (s.isDirectory())
    for (const n of readdirSync(p))
        walk(join(p, n));
else {
    const fd = openSync(p, "r+");
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
} } walk(root); }
export function journalDirectory(root: string): string { const d = join(root, ".staging", "transactions"); for (const p of [root, join(root, ".staging"), d]) {
    if (!existsSync(p))
        mkdirSync(p);
    if (lstatSync(p).isSymbolicLink())
        throw Error("unsafe_recovery_path");
} return d; }
export function writeUpdateJournal(root: string, j: UpdateJournal): void { j.updated = new Date().toISOString(); if (Buffer.byteLength(JSON.stringify(j)) > 65536)
    throw Error("update_journal_limit"); syncJson(join(journalDirectory(root), j.id + ".json"), j); }
export function readUpdateJournals(root: string): UpdateJournal[] { const d = join(root, ".staging", "transactions"); if (!existsSync(d))
    return []; for (const v of [root, join(root, ".staging"), d])
    if (lstatSync(v).isSymbolicLink())
        throw Error("unsafe_recovery_path"); return readdirSync(d).filter(n => n.endsWith(".json")).map(n => { const p = join(d, n), s = lstatSync(p); if (s.isSymbolicLink() || s.size > 65536)
    throw Error("unsafe_update_journal"); const j = JSON.parse(readFileSync(p, "utf8")) as UpdateJournal; if (!j || j.format !== "sinty.plugin-update/1" || !uuid.test(j.id) || n !== j.id + ".json" || !/^[a-z][a-z0-9-]{1,63}$/.test(j.name) || !Number.isSafeInteger(j.pid) || j.pid < 1 || !['prepared', 'old_move_intent', 'new_move_intent', 'activate_intent', 'ready', 'commit_intent', 'committed', 'rolled_back', 'recovery_required'].includes(j.phase) || typeof j.hasDataScope !== "boolean" || j.dataHash !== undefined && !/^(absent|[a-f0-9]{64})$/.test(j.dataHash) || typeof j.previousExisted !== "boolean" || !/^[a-f0-9]{64}$/.test(j.candidateHash) || j.previousHash !== undefined && !/^(absent|[a-f0-9]{64})$/.test(j.previousHash))
    throw Error("invalid_update_journal"); const flags = (v: unknown): boolean => v === undefined || !!v && typeof v === "object" && typeof (v as UpdateFlags).enabled === "boolean" && typeof (v as UpdateFlags).disabled === "boolean"; if (!flags(j.configBefore) || !flags(j.configAfter) || typeof j.created !== "string" || !Number.isFinite(Date.parse(j.created)) || typeof j.updated !== "string" || !Number.isFinite(Date.parse(j.updated)))
    throw Error("invalid_update_journal"); if (j.metadata && (typeof j.metadata.version !== "string" || (j.metadata.source==="catalog" ? j.metadata.signatureVerified!==true||j.metadata.trust!=="trusted-catalog"||typeof j.metadata.publisher!=="string"||!/^[a-f0-9]{64}$/.test(j.metadata.artifactSha256??"")||j.metadata.signatureScope!=="catalog-index" : j.metadata.signatureVerified!==false||j.metadata.publisher!==null||!["path","npm"].includes(j.metadata.source)||!["local-path-unverified","npm-registry-unverified"].includes(j.metadata.trust)) || j.metadata.changelog !== undefined && (typeof j.metadata.changelog !== "string" || j.metadata.changelog.length > 8192)))
    throw Error("invalid_update_receipt"); return j; }); }
export function updateHistory(root: string): unknown[] { return readUpdateJournals(root).map(j => ({ id: j.id, name: j.name, phase: j.phase, created: j.created, updated: j.updated, packageTreeHash: j.candidateHash, reason: j.reason ?? null, ...(j.metadata ?? {}) })).sort((a, b) => b.created.localeCompare(a.created)); }
export function ownerProcessAlive(pid: number): boolean { try {
    process.kill(pid, 0);
    return true;
}
catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
} }
export function restorePluginConfig(file: string | undefined, j: UpdateJournal): boolean {
    if (!file || !j.configBefore || !existsSync(file))
        return false;
    const doc = parseDocument(readFileSync(file, "utf8")), arr = (key: string): string[] => { const raw = doc.getIn(["plugins", key]); return raw && typeof raw === "object" && "toJSON" in raw ? (raw as {
        toJSON(): string[];
    }).toJSON() : []; }, on = arr("enabled"), off = arr("disabled"), now = { enabled: on.includes(j.name), disabled: off.includes(j.name) }, after = j.configAfter;
    if (now.enabled === j.configBefore.enabled && now.disabled === j.configBefore.disabled)
        return false;
    if (!after || now.enabled !== after.enabled || now.disabled !== after.disabled)
        throw Error("owner_config_changed");
    doc.setIn(["plugins", "enabled"], j.configBefore.enabled ? on.includes(j.name) ? on : [...on, j.name] : on.filter(n => n !== j.name));
    doc.setIn(["plugins", "disabled"], j.configBefore.disabled ? off.includes(j.name) ? off : [...off, j.name] : off.filter(n => n !== j.name));
    syncText(file, String(doc));
    return true;
}
export function recoverPluginTransactions(root: string, opts: {
    dataRoot: string;
    configPath?: string;
    isOwnerAlive?: (pid: number) => boolean;
}): {
    repaired: string[];
    blocked: {
        name: string;
        reason: string;
    }[];
    configRepairs: {
        name: string;
        flags: UpdateFlags;
    }[];
} {
    const out = { repaired: [] as string[], blocked: [] as {
            name: string;
            reason: string;
        }[], configRepairs: [] as {
            name: string;
            flags: UpdateFlags;
        }[] };
    if (!existsSync(root))
        return out;
    if (lstatSync(root).isSymbolicLink())
        throw Error("unsafe_recovery_path");
    for (const v of [opts.dataRoot, join(root, ".staging"), join(root, ".rollback")])
        if (existsSync(v) && lstatSync(v).isSymbolicLink())
            throw Error("unsafe_recovery_path");
    const alive = opts.isOwnerAlive ?? ownerProcessAlive, lock = join(root, ".staging", "plugin-install.lock");
    let owner: {
        format: string;
        pid: number;
        nonce: string;
    } | undefined;
    if (existsSync(lock)) {
        const st = lstatSync(lock);
        if (st.isSymbolicLink() || st.nlink > 1 || st.size > 1024)
            throw Error("unsafe_install_lock");
        try {
            owner = JSON.parse(readFileSync(lock, "utf8"));
        }
        catch {
            throw Error("legacy_install_lock_requires_review");
        }
        if (!owner || owner.format !== "sinty.plugin-lock/1" || !uuid.test(owner.nonce) || !Number.isSafeInteger(owner.pid) || owner.pid < 1)
            throw Error("invalid_install_lock");
        if (alive(owner.pid))
            throw Error("plugin_install_owner_active");
    }
    for (const j of readUpdateJournals(root)) {
        if (j.phase === "committed" || j.phase === "rolled_back")
            continue;
        if (alive(j.pid))
            throw Error("plugin_install_owner_active");
        const dest = join(root, j.name), old = join(root, ".rollback", j.name + "-" + j.id), incoming = join(root, ".staging", j.id), failed = join(root, ".staging", j.id + "-failed");
        try {
            const activated = ["activate_intent", "ready", "commit_intent", "recovery_required"].includes(j.phase);
            if (activated && j.hasDataScope && (!j.dataHash || packageFingerprint(join(opts.dataRoot, j.name)) !== j.dataHash))
                throw Error("data_review_required");
            const current = packageFingerprint(dest), backup = packageFingerprint(old);
            if (j.previousExisted) {
                if (j.previousHash && current === j.previousHash && backup === "absent") { /* already restored, idempotent */ }
                else if (j.previousHash && backup === j.previousHash) {
                    if (current !== "absent") {
                        if (current !== j.candidateHash || existsSync(failed))
                            throw Error("package_identity_changed");
                        renameSync(dest, failed);
                    }
                    renameSync(old, dest);
                }
                else if (j.phase === "prepared" && current !== "absent" && backup === "absent") { /* no rename had been authorized */ }
                else
                    throw Error("previous_package_unverified");
            }
            else if (current !== "absent") {
                if (current !== j.candidateHash || existsSync(failed))
                    throw Error("package_identity_changed");
                renameSync(dest, failed);
            }
            if (existsSync(incoming) && packageFingerprint(incoming) !== j.candidateHash)
                throw Error("candidate_identity_changed");
            restorePluginConfig(opts.configPath, j);
            if (j.configBefore)
                out.configRepairs.push({ name: j.name, flags: j.configBefore });
            j.phase = "rolled_back";
            j.reason = "interrupted_update_recovered";
            writeUpdateJournal(root, j);
            out.repaired.push(j.name);
        }
        catch (e) {
            j.phase = "recovery_required";
            j.reason = e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : "recovery_failed";
            writeUpdateJournal(root, j);
            out.blocked.push({ name: j.name, reason: j.reason });
        }
    }
    if (owner && existsSync(lock)) {
        const current = JSON.parse(readFileSync(lock, "utf8"));
        if (current.nonce === owner.nonce)
            unlinkSync(lock);
    }
    return out;
}
