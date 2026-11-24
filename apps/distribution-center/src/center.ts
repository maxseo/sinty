// @ts-expect-error Shared standalone streaming contracts are JavaScript.
import {inspectHarnessArchive,fileDigest,receiveToFile} from "../../../packages/release-tools/harness-archive.mjs";
import {createReadStream} from "node:fs";
import {pipeline} from "node:stream/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, createPrivateKey, createPublicKey, randomBytes, scryptSync, timingSafeEqual, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { readPluginTarGz } from "../../../packages/core/src/plugin-archive.ts";
import { validPluginVersion, validPluginRange } from "../../../packages/core/src/plugin-release.ts";
export interface CenterOptions {
    maxHarnessArtifactBytes?: number;
    dataDir: string;
    signingKeyFile: string;
    publicBaseUrl: string;
    bootstrapSecret?: string;
    testHttpLoopback?: boolean;
    now?: () => number;
}
class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex"), idRE = /^[a-z][a-z0-9-]{1,63}$/;
const inside = (root: string, p: string) => { const r = relative(root, p); return !r || !isAbsolute(r) && r !== ".." && !r.startsWith("..\\") && !r.startsWith("../"); };
function text(b: Buffer, max = 65536) {
    if (b.length > max)
        throw new HttpError(413, "Metadata too large");
    return b.toString("utf8");
}
function obj(x: unknown): Record<string, unknown> {
    if (!x || typeof x !== "object" || Array.isArray(x))
        throw new HttpError(400, "Object required");
    return x as Record<string, unknown>;
}
function passwordHash(password: string, salt: string) { return scryptSync(password, salt, 64).toString("hex"); }
function same(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function createDistributionCenter(options: CenterOptions) {
    const now = options.now ?? Date.now, base = new URL(options.publicBaseUrl);
    if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || base.protocol !== "https:" && !(options.testHttpLoopback && base.protocol === "http:" && base.hostname === "127.0.0.1"))
        throw Error("HTTPS origin required");
    const maxHarnessArtifactBytes=options.maxHarnessArtifactBytes??512*1024**2;if(!Number.isSafeInteger(maxHarnessArtifactBytes)||maxHarnessArtifactBytes<1||maxHarnessArtifactBytes>2*1024**3)throw Error("Invalid harness artifact limit");
    const root = resolve(options.dataDir), keyFile = resolve(options.signingKeyFile);
    if (inside(root, keyFile))
        throw Error("Signing key must be outside data/artifact volumes");
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink())
        throw Error("Data root cannot be a link");
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    if (lstatSync(artifacts).isSymbolicLink())
        throw Error("Artifact root cannot be a link");
    const key = createPrivateKey(readFileSync(keyFile));
    if (key.asymmetricKeyType !== "ed25519")
        throw Error("Ed25519 signing key required");
    const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
    const db = new DatabaseSync(join(root, "center.sqlite"));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS admin(id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt TEXT NOT NULL,password_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS releases(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,version TEXT NOT NULL,platform TEXT NOT NULL,arch TEXT NOT NULL,channel TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,metadata TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',hidden INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL, UNIQUE(kind,name,version,platform,arch,channel));
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,release_id INTEGER,action TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS availability(name TEXT PRIMARY KEY,hidden INTEGER NOT NULL);
 INSERT OR IGNORE INTO meta VALUES('sequence','0');`);
    const rates = new Map<string, {
        start: number;
        attempts: number;
    }>();
    const transaction = <T>(fn: () => T): T => {
        db.exec("BEGIN IMMEDIATE");
        try {
            const value = fn();
            db.exec("COMMIT");
            return value;
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
    };
    const event = (id: number | null, action: string) => db.prepare("INSERT INTO events(release_id,action,created) VALUES(?,?,?)").run(id, action, now());
    const emit = (res: ServerResponse, status: number, x: unknown) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(x)); };
    const origin = (req: IncomingMessage) => {
        if (req.headers.origin && req.headers.origin !== publicOrigin() || req.headers["sec-fetch-site"] === "cross-site")
            throw new HttpError(403, "Cross-origin request denied");
    };
    const limitLogin = (req: IncomingMessage) => {
        const ip = req.socket.remoteAddress ?? "unknown", n = now(), old = rates.get(ip);
        if (!old || n - old.start > 60000) {
            rates.set(ip, { start: n, attempts: 1 });
        }
        else if (++old.attempts > 8)
            throw new HttpError(429, "Try again later");
        if (rates.size > 10000)
            for (const [k, v] of rates)
                if (n - v.start > 60000)
                    rates.delete(k);
    };
    const session = (req: IncomingMessage) => {
        const cookie = String(req.headers.cookie ?? "").split(";").map(v => v.trim()).find(v => v.startsWith("sinty_center="))?.slice(13);
        if (!cookie || !/^[a-f0-9]{64}$/.test(cookie))
            throw new HttpError(401, "Admin sign-in required");
        const s = db.prepare("SELECT * FROM sessions WHERE hash=? AND expires>?").get(sha(cookie), now()) as {
            hash: string;
            csrf: string;
            expires: number;
        } | undefined;
        if (!s)
            throw new HttpError(401, "Admin sign-in required");
        if (!["GET", "HEAD"].includes(req.method ?? "")) {
            origin(req);
            if (!same(String(req.headers["x-csrf-token"] ?? ""), s.csrf))
                throw new HttpError(403, "CSRF token required");
        }
        return s;
    };
    const newSession = (res: ServerResponse) => { const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex"); db.prepare("DELETE FROM sessions WHERE expires<=?").run(now()); db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sha(token), csrf, now() + 8 * 3600000); res.setHeader("Set-Cookie", `sinty_center=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${base.protocol === "https:" ? "; Secure" : ""}`); return csrf; };
    const body = (req: IncomingMessage, max: number) => new Promise<Buffer>((done, fail) => {
        let n = 0, over = false;
        const chunks: Buffer[] = [];
        req.on("data", chunk => {
            if (over)
                return;
            const b = Buffer.from(chunk);
            if ((n += b.length) > max) {
                over = true;
                chunks.length = 0;
                fail(new HttpError(413, "Upload limit exceeded"));
            }
            else
                chunks.push(b);
        });
        req.on("end", () => {
            if (!over)
                done(Buffer.concat(chunks));
        });
        req.on("error", () => fail(new HttpError(400, "Request interrupted")));
    });
    const json = async (req: IncomingMessage) => {
        if (!String(req.headers["content-type"]).startsWith("application/json"))
            throw new HttpError(415, "JSON required");
        try {
            return obj(JSON.parse(text(await body(req, 65536))));
        }
        catch (e) {
            if (e instanceof HttpError)
                throw e;
            throw new HttpError(400, "Invalid JSON");
        }
    };
    const publicIndex = (kind: string) => {
        const rows = db.prepare("SELECT * FROM releases WHERE kind=? AND status='published' AND hidden=0 AND NOT EXISTS(SELECT 1 FROM availability a WHERE a.name=releases.name AND a.hidden=1 AND releases.kind='plugin') ORDER BY name,version").all(kind) as Record<string, unknown>[];
        const sequence = Number((db.prepare("SELECT value FROM meta WHERE key='sequence'").get() as {
            value: string;
        }).value);
        return { format: kind === "plugin" ? "sinty.plugins/1" : "sinty.harness/1", sequence, expires: new Date(now() + 7 * 86400000).toISOString(), [kind === "plugin" ? "packages" : "releases"]: rows.map(r => ({ name: r.name, version: r.version, publisher: "syntoffice", url: publicOrigin() + "/artifacts/" + r.sha256 + ".tgz", sha256: r.sha256, bytes: r.bytes, ...(kind === "harness" ? { platform: r.platform, arch: r.arch, channel: r.channel, ...JSON.parse(String(r.metadata)) } : {}) })) };
    };
    // Cache exact index/signature byte pairs; refreshed together on state changes/expiry bucket.
    let cache = new Map<string, {
        bucket: number;
        sequence: number;
        bytes: Buffer;
        signature: Buffer;
    }>();
    const signedIndex = (kind: string) => {
        const sequence = Number((db.prepare("SELECT value FROM meta WHERE key='sequence'").get() as {
            value: string;
        }).value), bucket = Math.floor(now() / 3600000), hit = cache.get(kind);
        if (hit && hit.bucket === bucket && hit.sequence === sequence)
            return hit;
        const bytes = Buffer.from(JSON.stringify(publicIndex(kind))), value = { bucket, sequence, bytes, signature: sign(null, bytes, key) };
        cache.set(kind, value);
        return value;
    };
    const inspect = (bytes: Buffer, kind: string, params: URLSearchParams) => {
        const entries = readPluginTarGz(bytes, { maxCompressed: 20000000 }), prefix = kind === "plugin" ? "package/" : "harness/";
        if (!entries.length || entries.some(e => !e.path.startsWith(prefix) && e.path !== prefix.slice(0, -1)))
            throw new HttpError(400, "Archive root must be " + prefix);
        const files = new Map(entries.filter(e => !e.directory).map(e => [e.path, e.bytes]));
        for (const [p, b] of files) {
            if (/(^|\/)(\.env(?:\..*)?|\.npmrc|\.git-credentials)$|\.(pem|key|pfx)$/i.test(p) || /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/.test(b.toString("utf8")))
                throw new HttpError(400, "Sensitive material rejected");
        }
        const mf = files.get(prefix + (kind === "plugin" ? "sinty.plugin.json" : "release.json"));
        if (!mf)
            throw new HttpError(400, "Release manifest missing");
        const m = obj(JSON.parse(text(mf)));
        if (typeof m.version !== "string" || !validPluginVersion(m.version))
            throw new HttpError(400, "Strict version required");
        const name = kind === "plugin" ? m.name : "sinty";
        if (typeof name !== "string" || !idRE.test(name))
            throw new HttpError(400, "Invalid name");
        const compatibility = m.compatibility === undefined ? {} : obj(m.compatibility);
        for (const k of ["core", "sdk"]) {
            const v = compatibility[k];
            if (v !== undefined && (typeof v !== "string" || !validPluginRange(v)))
                throw new HttpError(400, "Invalid compatibility range");
        }
        let changelog = "";
        if (m.changelog !== undefined) {
            if (typeof m.changelog !== "string" || m.changelog.includes("..") || m.changelog.startsWith("/") || m.changelog.includes("\\"))
                throw new HttpError(400, "Invalid changelog path");
            const c = files.get(prefix + m.changelog);
            if (!c)
                throw new HttpError(400, "Changelog missing");
            changelog = text(c, 32768);
        }
        if (kind === "plugin") {
            if (m.categories !== undefined && (!Array.isArray(m.categories) || m.categories.length < 1 || m.categories.length > 3 || new Set(m.categories).size !== m.categories.length || m.categories.some(x => !["system", "functional", "ui"].includes(String(x)))))
                throw new HttpError(400, "Invalid descriptive categories");
            if (m.updateMode !== undefined && !["rpc-only", "restart"].includes(String(m.updateMode)))
                throw new HttpError(400, "Invalid update mode");
            if (!Array.isArray(m.kinds) || new Set(m.kinds).size !== m.kinds.length || m.kinds.some(x => !["provider", "tool", "context", "channel", "server", "schedule", "event", "ui", "memory"].includes(String(x))))
                throw new HttpError(400, "Invalid plugin kinds");
            obj(m.permissions);
            if (!["node", "mcp-stdio", "http"].includes(String(m.runtime)) || !Array.isArray(m.kinds) || !m.kinds.length || !m.permissions || typeof m.permissions !== "object")
                throw new HttpError(400, "Invalid plugin metadata");
            if (m.runtime === "node" && (typeof m.entry !== "string" || !files.has(prefix + m.entry)))
                throw new HttpError(400, "Node entry missing");
            const pkg = files.get(prefix + "package.json");
            if (pkg && obj(JSON.parse(text(pkg))).version !== m.version)
                throw new HttpError(400, "Package/manifest version mismatch");
            return { name, version: m.version, platform: "any", arch: "any", channel: "stable", metadata: { changelog, compatibility, permissions: m.permissions, categories: m.categories ?? [], updateMode: m.updateMode ?? "restart" } };
        }
        if (m.dataCompatibility !== undefined && !["requires-review", "unchanged", "backward-compatible", "forward-only"].includes(String(m.dataCompatibility)))
            throw new HttpError(400, "Invalid data compatibility marker");
        const platform = String(m.platform), arch = String(m.arch), channel = String(m.channel ?? "stable");
        if (!["win32", "linux"].includes(platform) || !["x64", "arm64"].includes(arch) || channel !== "stable" || typeof m.coreVersion !== "string" || !validPluginVersion(m.coreVersion) || typeof m.sdkVersion !== "string" || !validPluginVersion(m.sdkVersion))
            throw new HttpError(400, "Invalid harness platform/version/channel");
        return { name, version: m.version, platform, arch, channel, metadata: { coreVersion: m.coreVersion, sdkVersion: m.sdkVersion, compatibility, changelog, applySupported: false, dataCompatibility: m.dataCompatibility ?? "requires-review" } };
    };
    const handler = async (req: IncomingMessage, res: ServerResponse) => {
        try {
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Referrer-Policy", "no-referrer");
            const u = new URL(req.url ?? "/", base), method = req.method ?? "GET";
            if (method === "GET" && u.pathname === "/health") {
                emit(res, 200, { ok: true, service: "syntoffice-distribution" });
                return;
            }
            if (method === "GET" && ["/index.json", "/index.json.sig", "/harness-index.json", "/harness-index.json.sig"].includes(u.pathname)) {
                const pair = signedIndex(u.pathname.startsWith("/harness") ? "harness" : "plugin"), sig = u.pathname.endsWith(".sig");
                res.writeHead(200, { "Content-Type": sig ? "application/octet-stream" : "application/json", "Cache-Control": "public,max-age=30" });
                res.end(sig ? pair.signature : pair.bytes);
                return;
            }
            if (method === "GET" && /^\/artifacts\/[a-f0-9]{64}\.tgz$/.test(u.pathname)) {
                const digest = u.pathname.split('/').pop()!.slice(0, -4), row = db.prepare("SELECT bytes FROM releases WHERE sha256=? AND status='published' LIMIT 1").get(digest);
                if (!row)
                    throw new HttpError(404, "Not found");
                const artifact=join(artifacts,digest+".tgz");
                if (await fileDigest(artifact) !== digest)
                    throw new HttpError(503, "Artifact integrity check failed");
                res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": Number(row.bytes), "Cache-Control": "public,max-age=31536000,immutable" });
                await pipeline(createReadStream(artifact),res);
                return;
            }
            if (method === "GET" && ["/admin", "/admin/", "/admin/app.js", "/admin/style.css"].includes(u.pathname)) {
                const name = u.pathname.endsWith("app.js") ? "app.js" : u.pathname.endsWith("style.css") ? "style.css" : "index.html";
                res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
                res.setHeader("Content-Type", name.endsWith('.js') ? "text/javascript; charset=utf-8" : name.endsWith('.css') ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
                res.end(readFileSync(new URL("../public/" + name, import.meta.url)));
                return;
            }
            if (method === "GET" && u.pathname === "/api/admin/setup") {
                emit(res, 200, { needed: !db.prepare("SELECT id FROM admin").get(), enabled: !db.prepare("SELECT id FROM admin").get() && !!options.bootstrapSecret && options.bootstrapSecret.length >= 32 });
                return;
            }
            if (method === "POST" && u.pathname === "/api/admin/bootstrap") {
                origin(req);
                limitLogin(req);
                if (!options.bootstrapSecret || options.bootstrapSecret.length < 32 || !same(String(req.headers.authorization ?? ""), "Bearer " + options.bootstrapSecret))
                    throw new HttpError(403, "Local bootstrap authorization required");
                const x = await json(req);
                if (typeof x.username !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(x.username) || typeof x.password !== "string" || x.password.length < 12 || x.password.length > 128)
                    throw new HttpError(400, "Invalid admin fields");
                const salt = randomBytes(16).toString("hex"), hash = passwordHash(x.password, salt);
                transaction(() => {
                    if (db.prepare("SELECT id FROM admin").get())
                        throw new HttpError(409, "Bootstrap already closed");
                    db.prepare("INSERT INTO admin VALUES(1,?,?,?)").run(x.username as string, salt, hash);
                    event(null, "bootstrap-complete");
                });
                emit(res, 201, { csrf: newSession(res) });
                return;
            }
            if (method === "POST" && u.pathname === "/api/admin/login") {
                origin(req);
                limitLogin(req);
                const x = await json(req), admin = db.prepare("SELECT * FROM admin WHERE id=1").get() as {
                    username: string;
                    salt: string;
                    password_hash: string;
                } | undefined;
                if (typeof x.username !== "string" || typeof x.password !== "string" || x.password.length > 128 || !admin || !same(x.username, admin.username) || !same(passwordHash(x.password, admin.salt), admin.password_hash))
                    throw new HttpError(401, "Invalid sign-in");
                emit(res, 200, { csrf: newSession(res) });
                return;
            }
            if (!u.pathname.startsWith("/api/admin/"))
                throw new HttpError(404, "Not found");
            const auth = session(req);
            if (method === "GET" && u.pathname === "/api/admin/session") {
                emit(res, 200, { csrf: auth.csrf,limits:{plugin:20000000,harness:maxHarnessArtifactBytes} });
                return;
            }
            // Sole-owner recovery through an already authenticated session. No public reset or old-password disclosure.
            if (method === "POST" && u.pathname === "/api/admin/password") {
                const x = await json(req);
                if (Object.keys(x).some(k => k !== "password") || typeof x.password !== "string" || x.password.length < 12 || x.password.length > 128)
                    throw new HttpError(400, "New password must contain 12 to 128 characters");
                const salt = randomBytes(16).toString("hex"), hash = passwordHash(x.password, salt);
                transaction(() => {
                    if (!db.prepare("SELECT hash FROM sessions WHERE hash=? AND expires>?").get(auth.hash, now())) throw new HttpError(401, "Admin sign-in required");
                    if (!db.prepare("SELECT id FROM admin WHERE id=1").get()) throw new HttpError(409, "Admin account missing");
                    db.prepare("UPDATE admin SET salt=?,password_hash=? WHERE id=1").run(salt, hash);
                    db.prepare("DELETE FROM sessions WHERE hash<>?").run(auth.hash);
                    event(null, "admin-password-changed");
                });
                emit(res, 200, { changed: true, otherSessionsRevoked: true });
                return;
            }
            if (method === "POST" && u.pathname === "/api/admin/logout") {
                db.prepare("DELETE FROM sessions WHERE hash=?").run(auth.hash);
                res.setHeader("Set-Cookie", "sinty_center=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
                emit(res, 200, { ok: true });
                return;
            }
            if (method === "GET" && u.pathname === "/api/admin/releases") {
                const releases = db.prepare("SELECT releases.*,COALESCE((SELECT hidden FROM availability a WHERE a.name=releases.name AND releases.kind='plugin'),0) AS pluginHidden FROM releases ORDER BY created DESC,id DESC").all().map(r => ({ ...r, metadata: JSON.parse(String(r.metadata)) }));
                emit(res, 200, { releases, events: db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100").all() });
                return;
            }
            if (method === "POST" && u.pathname === "/api/admin/uploads") {
                const kind = u.searchParams.get("kind");
                if (kind !== "plugin" && kind !== "harness")
                    throw new HttpError(400, "Release kind required");
                if (!String(req.headers["content-type"]).startsWith("application/gzip"))
                    throw new HttpError(415, "Upload a .tgz package");
                const limit=kind==="harness"?maxHarnessArtifactBytes:20000000;if(Number(req.headers["content-length"]??0)>limit)throw new HttpError(413,"Upload limit exceeded");
                const incoming=join(root,"incoming-"+randomBytes(12).toString("hex")+".tmp");try{const received=await receiveToFile(req,incoming,limit);let record;
                try{if(kind==="plugin")record=inspect(readFileSync(incoming),kind,u.searchParams);else{const info=await inspectHarnessArchive(incoming,{maxCompressed:limit});const m=obj(info.manifest),version=m.version,platform=m.platform,arch=m.arch,channel=m.channel??"stable";if(typeof version!=="string"||!validPluginVersion(version)||!["win32","linux"].includes(String(platform))||!["x64","arm64"].includes(String(arch))||channel!=="stable"||typeof m.coreVersion!=="string"||!validPluginVersion(m.coreVersion)||typeof m.sdkVersion!=="string"||!validPluginVersion(m.sdkVersion))throw new HttpError(400,"Invalid harness release metadata");const compatibility=m.compatibility===undefined?{}:obj(m.compatibility);for(const k of ["core","sdk"]){const r=compatibility[k];if(r!==undefined&&(typeof r!=="string"||!validPluginRange(r)))throw new HttpError(400,"Invalid compatibility range")};if(m.updaterProtocol!==undefined&&(m.updaterProtocol!==1||typeof m.nodeRange!=="string"||!validPluginRange(m.nodeRange)||typeof m.dataSchema!=="string"||!/^[a-zA-Z0-9._-]{1,64}$/.test(m.dataSchema)||m.migrations!=="none"||m.dataCompatibility!=="unchanged"))throw new HttpError(400,"Unsupported managed update protocol");record={name:"sinty",version,platform:String(platform),arch:String(arch),channel:String(channel),metadata:{coreVersion:m.coreVersion,sdkVersion:m.sdkVersion,compatibility,changelog:info.changelog,dataCompatibility:m.dataCompatibility??"requires-review",updaterProtocol:m.updaterProtocol??null,nodeRange:m.nodeRange??null,dataSchema:m.dataSchema??null,migrations:m.migrations??null,applySupported:m.updaterProtocol===1&&platform==="win32"}}}}
                catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,"Invalid or unsafe release package")}
                const digest=received.sha256,file=join(artifacts,digest+".tgz");if(existsSync(file)&&await fileDigest(file)!==digest)throw new HttpError(503,"Stored artifact integrity failure");const existing=db.prepare("SELECT id,sha256 FROM releases WHERE kind=? AND name=? AND version=? AND platform=? AND arch=? AND channel=?").get(kind,record.name,record.version,record.platform,record.arch,record.channel) as {id:number;sha256:string}|undefined;if(existing){if(existing.sha256!==digest)throw new HttpError(409,"Immutable version conflict");emit(res,200,{id:existing.id,status:"existing"});return}if(!existsSync(file))renameSync(incoming,file);const id=transaction(()=>{const result=db.prepare("INSERT INTO releases(kind,name,version,platform,arch,channel,sha256,bytes,metadata,created) VALUES(?,?,?,?,?,?,?,?,?,?)").run(kind,record.name,record.version,record.platform,record.arch,record.channel,digest,received.bytes,JSON.stringify(record.metadata),now());const id=Number(result.lastInsertRowid);event(id,"upload-draft");return id});emit(res,201,{id,status:"draft",sha256:digest,...record})}finally{if(existsSync(incoming))unlinkSync(incoming)}

                return;
            }
            const visible = /^\/api\/admin\/plugins\/([a-z][a-z0-9-]{1,63})\/visibility$/.exec(u.pathname);
            if (method === "POST" && visible) {
                const x = await json(req);
                if (typeof x.visible !== "boolean" || x.confirm !== true)
                    throw new HttpError(400, "Explicit visibility confirmation required");
                transaction(() => { db.prepare("INSERT INTO availability(name,hidden) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET hidden=excluded.hidden").run(visible[1]!, x.visible ? 0 : 1); db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='sequence'").run(); event(null, (x.visible ? "plugin-show:" : "plugin-hide:") + visible[1]); });
                cache.clear();
                emit(res, 200, { ok: true });
                return;
            }
            const match = /^\/api\/admin\/releases\/(\d+)\/(publish|hide|show)$/.exec(u.pathname);
            if (method === "POST" && match) {
                const x = await json(req);
                if (x.confirm !== true)
                    throw new HttpError(400, "Explicit confirmation required");
                const id = Number(match[1]), action = match[2]!;
                if(action==="publish"){const r=db.prepare("SELECT sha256 FROM releases WHERE id=?").get(id) as {sha256:string}|undefined;if(!r)throw new HttpError(404,"Not found");if(await fileDigest(join(artifacts,r.sha256+".tgz"))!==r.sha256)throw new HttpError(409,"Artifact integrity failure")}
                transaction(() => {
                    const row = db.prepare("SELECT * FROM releases WHERE id=?").get(id) as {
                        status: string;
                        sha256: string;
                    } | undefined;
                    if (!row)
                        throw new HttpError(404, "Not found");
                    if (action !== "publish" && row.status !== "published")
                        throw new HttpError(409, "Draft is not published");
                    if (action === "publish") {
                        if (row.status === "published")
                            return;
                        
                        db.prepare("UPDATE releases SET status='published',hidden=0 WHERE id=?").run(id);
                    }
                    else
                        db.prepare("UPDATE releases SET hidden=? WHERE id=?").run(action === "hide" ? 1 : 0, id);
                    db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='sequence'").run();
                    event(id, action);
                });
                cache.clear();
                emit(res, 200, { ok: true });
                return;
            }
            throw new HttpError(404, "Not found");
        }
        catch (e) {
            if (!res.headersSent)
                emit(res, e instanceof HttpError ? e.status : 500, { error: { message: e instanceof HttpError ? e.message : "Distribution service failed" } });
            else
                res.end();
        }
    };
    function publicOrigin() { const a = server.address(); return options.testHttpLoopback && base.port === "0" && a && typeof a === "object" ? "http://127.0.0.1:" + a.port : base.origin; }
    let closed = false;
    const server = createServer((req, res) => { void handler(req, res); });
    server.requestTimeout = 600000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 40;
    return { server, publicKey, close: async () => {
            if (closed)
                return;
            closed = true;
            server.closeAllConnections();
            await new Promise<void>(r => server.close(() => r()));
            db.close();
        } };
}
