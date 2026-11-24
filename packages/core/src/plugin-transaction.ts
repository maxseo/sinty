import { fsyncSync } from "node:fs";
import { restorePluginConfig, flushPackage, packageFingerprint, writeUpdateJournal, type UpdateJournal, type UpdateReceipt, type UpdateFlags, type UpdatePhase } from "./plugin-recovery.js";
import { cpSync, existsSync, mkdirSync, readdirSync, lstatSync, realpathSync, renameSync, rmSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
export class PluginTransactionError extends Error {
    constructor(readonly code: string, message: string, readonly rollbackRestored?: boolean) { super(message); }
}
function child(root: string, p: string): boolean { const rel = relative(root, p); return !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep); }
export function safeManagedDirectory(root: string, name: string): string {
    const p = join(root, name);
    if (!existsSync(p))
        mkdirSync(p);
    if (lstatSync(p).isSymbolicLink() || !child(realpathSync(root), realpathSync(p)))
        throw new PluginTransactionError("unsafe_plugin_path", "Managed directory escapes plugin root");
    return p;
}
/** Bounded materialized folder. Links are rejected, not followed into unrelated files. */
export function validatePluginTree(root: string): void {
    let count = 0, total = 0;
    const real = realpathSync(root);
    function walk(p: string, depth: number): void {
        if (depth > 32)
            throw new PluginTransactionError("package_limits", "Package too deep");
        const st = lstatSync(p);
        if (st.isSymbolicLink() || p !== root && !child(real, realpathSync(p)))
            throw new PluginTransactionError("unsafe_package", "Package links are not allowed");
        if (st.isDirectory()) {
            for (const e of readdirSync(p)) {
                if ([".git", ".staging", ".rollback"].includes(e))
                    continue;
                walk(join(p, e), depth + 1);
            }
        }
        else if (st.isFile()) {
            if (st.nlink > 1)
                throw new PluginTransactionError("unsafe_package", "Hardlinked package file");
            if (++count > 20000 || (total += st.size) > 256 * 1024 * 1024)
                throw new PluginTransactionError("package_limits", "Package exceeds limits");
        }
        else
            throw new PluginTransactionError("unsafe_package", "Unsupported package entry");
    }
    ;
    walk(root, 0);
}
export async function transactPluginDirectory<T>(o: {
    root: string;
    name: string;
    source: string;
    validate: (dir: string) => void;
    stop: () => Promise<void>;
    activate: () => Promise<T>;
    commit: () => void;
    restoreRuntime: () => Promise<void>;
    dataRoot?: string;
    configPath?: string;
    metadata?: UpdateReceipt;
    configBefore?: UpdateFlags;
    configAfter?: UpdateFlags;
    checkpoint?: (phase: UpdatePhase) => void;
    rename?: (from: string, to: string) => void;
}): Promise<{
    value: T;
    previous?: string;
}> {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(o.name))
        throw new PluginTransactionError("bad_name", "Invalid plugin name");
    mkdirSync(o.root, { recursive: true });
    if (lstatSync(o.root).isSymbolicLink())
        throw new PluginTransactionError("unsafe_plugin_path", "Plugin root must not be a link");
    const staging = safeManagedDirectory(o.root, ".staging"), history = safeManagedDirectory(o.root, ".rollback"), lock = join(staging, "plugin-install.lock"), nonce = randomUUID();
    let fd: number;
    try {
        fd = openSync(lock, "wx");
        writeFileSync(fd, JSON.stringify({ format: "sinty.plugin-lock/1", pid: process.pid, nonce }));
        fsyncSync(fd);
        closeSync(fd);
    }
    catch {
        throw new PluginTransactionError("install_busy", "Another install or an unreviewed stale transaction holds the lock");
    }
    const incoming = join(staging, nonce), dest = join(o.root, o.name), previous = join(history, o.name + "-" + nonce), move = o.rename ?? renameSync;
    let backed = false, activated = false, entered = false, quiesced = false;
    let journal: UpdateJournal | undefined;
    const phase = (v: UpdatePhase): void => { if (journal) {
        journal.phase = v;
        writeUpdateJournal(o.root, journal);
        o.checkpoint?.(v);
    } };
    try {
        validatePluginTree(o.source);
        cpSync(o.source, incoming, { recursive: true, filter: p => ![".git", ".staging", ".rollback"].includes(p.split(/[\\/]/).pop()!) });
        validatePluginTree(incoming);
        o.validate(incoming);
        flushPackage(incoming);
        journal = { format: "sinty.plugin-update/1", id: nonce, pid: process.pid, name: o.name, phase: "prepared", created: new Date().toISOString(), updated: new Date().toISOString(), previousExisted: existsSync(dest), candidateHash: packageFingerprint(incoming), hasDataScope: !!o.dataRoot, ...(o.metadata ? { metadata: o.metadata } : {}), ...(o.configBefore ? { configBefore: o.configBefore } : {}), ...(o.configAfter ? { configAfter: o.configAfter } : {}) };
        phase("prepared");
        quiesced = true;
        await o.stop();
        journal.previousHash = packageFingerprint(dest);
        if (o.dataRoot)
            journal.dataHash = packageFingerprint(join(o.dataRoot, o.name));
        phase("old_move_intent");
        if (existsSync(dest)) {
            if (lstatSync(dest).isSymbolicLink())
                throw new PluginTransactionError("unsafe_plugin_path", "Destination plugin cannot be a link");
            move(dest, previous);
            backed = true;
        }
        phase("new_move_intent");
        move(incoming, dest);
        activated = true;
        entered = true;
        phase("activate_intent");
        const value = await o.activate();
        phase("ready");
        phase("commit_intent");
        o.commit();
        phase("committed");
        return { value, ...(backed ? { previous } : {}) };
    }
    catch (e) {
        if (!quiesced && !backed && !activated && !entered)
            throw e;
        let restored = true;
        const dataSafe = (): boolean => !entered || !o.dataRoot || !!journal?.dataHash && packageFingerprint(join(o.dataRoot, o.name)) === journal.dataHash;
        try {
            await o.stop();
        }
        catch {
            restored = false;
        }
        try {
            if (!restored || !dataSafe())
                throw new Error("data_review_required");
            if (activated && existsSync(dest))
                move(dest, join(staging, nonce + "-failed"));
            if (backed)
                move(previous, dest);
        }
        catch {
            restored = false;
        }
        try {
            if (restored) {
                if (journal)
                    restorePluginConfig(o.configPath, journal);
                await o.restoreRuntime();
            }
        }
        catch {
            restored = false;
        }
        if (journal) {
            journal.reason = restored ? "activation_failed_rolled_back" : "data_or_runtime_review_required";
            try {
                phase(restored ? "rolled_back" : "recovery_required");
            }
            catch {
                throw new PluginTransactionError("journal_persistence_failed", "Update journal requires recovery; automatic plugin restart is blocked", false);
            }
        }
        throw new PluginTransactionError(restored ? "activation_failed_rolled_back" : "rollback_failed", "Plugin activation failed; previous package " + (restored ? "restored" : "requires recovery"), restored);
    }
    finally {
        if (existsSync(incoming))
            rmSync(incoming, { recursive: true, force: true });
        try {
            if (JSON.parse(readFileSync(lock, "utf8")).nonce === nonce)
                unlinkSync(lock);
        }
        catch { }
    }
}
