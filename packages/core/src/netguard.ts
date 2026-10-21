import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import zlib from "node:zlib";
import { classifyAddress, isLocalHostname, parseIPv4, parseIPv6 } from "@sinty/sdk";

/**
 * The core's guard for public internet (`ctx.net.public`, plan step 7). Every request resolves the host, refuses
 * anything that is not public internet unless the human allow-listed it, then connects to exactly the address it
 * checked, so a second DNS answer cannot point somewhere else (DNS rebinding). Redirects go through the same check.
 * The browser proxy applies the same rule to every connection Chromium opens.
 */

export class NetGuardError extends Error {
  constructor(
    readonly code: "net_blocked" | "net_denied" | "too_large" | "timeout" | "net_failed" | "bad_request",
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "NetGuardError";
  }
}

const BLOCKED_HINT = "Only public http(s) pages. Private hosts are blocked.";

export interface AllowEntry {
  host: string;
  port?: number;
}

/** A resolver: `dns.lookup(host, { all: true })` by default; tests pass their own. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export interface GuardOptions {
  /** config.yaml `plugins.config.<plugin>.allowPrivate`, parsed with parseAllowPrivate. */
  allow?: AllowEntry[];
  resolve?: Resolver;
}

export interface Target {
  host: string;
  address: string;
  family: 4 | 6;
  port: number;
}

const defaultResolve: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((r) => ({ address: r.address, family: r.family }));

/** Normalises an IP literal for comparison (`::FFFF:7F00:1` and `::ffff:127.0.0.1` are the same). */
function ipKey(s: string): string | undefined {
  const v4 = parseIPv4(s);
  if (v4) return v4.join(".");
  const v6 = parseIPv6(s);
  if (!v6) return undefined;
  if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) return v6.slice(12).join(".");
  return v6.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hostKey(s: string): string {
  const h = s.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return ipKey(h) ?? h;
}

/**
 * `allowPrivate` from config.yaml: a list or one string of entries separated by commas, spaces or new lines.
 * An entry is `host`, `host:port`, `[v6]:port` or a bare IPv6 address. Bad entries are dropped.
 */
export function parseAllowPrivate(value: unknown): AllowEntry[] {
  const raw = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];
  const out: AllowEntry[] = [];
  for (const item of raw.flatMap((v) => v.split(/[\s,;]+/))) {
    const e = item.trim();
    if (!e) continue;
    let host = e;
    let port: number | undefined;
    const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(e);
    if (bracket) {
      host = bracket[1]!;
      port = bracket[2] ? Number(bracket[2]) : undefined;
    } else if ((e.match(/:/g) ?? []).length === 1) {
      const [h, p] = e.split(":");
      if (!/^\d{1,5}$/.test(p ?? "")) continue;
      host = h!;
      port = Number(p);
    }
    if (port !== undefined && (port < 1 || port > 65535)) continue;
    if (!/^[A-Za-z0-9.\-:%_]+$/.test(host)) continue;
    out.push({ host: hostKey(host), ...(port !== undefined ? { port } : {}) });
  }
  return out;
}

function allowed(allow: readonly AllowEntry[], names: string[], port: number): boolean {
  const keys = names.map(hostKey);
  return allow.some((a) => keys.includes(a.host) && (a.port === undefined || a.port === port));
}

/**
 * Resolves `host` and returns the one address to connect to. Throws `net_blocked` when the name is local or any
 * address it resolves to is not public internet (all of them are checked, so a mixed answer cannot slip through).
 */
export async function resolvePublic(rawHost: string, port: number, opts: GuardOptions = {}): Promise<Target> {
  const allow = opts.allow ?? [];
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new NetGuardError("net_blocked", "url has no host", BLOCKED_HINT);
  const literal = parseIPv4(host) ? 4 : parseIPv6(host) ? 6 : 0;
  if (literal) {
    const cls = classifyAddress(host);
    if (cls && !allowed(allow, [host], port)) throw new NetGuardError("net_blocked", `${host} is a ${cls} address; private addresses are blocked`, BLOCKED_HINT);
    return { host, address: host.replace(/%.*$/, ""), family: literal, port };
  }
  if (!/^[a-z0-9._-]+$/.test(host)) throw new NetGuardError("net_blocked", `host ${host} is not a valid name`, BLOCKED_HINT);
  const hostAllowed = allowed(allow, [host], port);
  if (isLocalHostname(host) && !hostAllowed) throw new NetGuardError("net_blocked", `local host ${host} is blocked`, BLOCKED_HINT);
  let records: { address: string; family: number }[];
  try {
    records = await (opts.resolve ?? defaultResolve)(host);
  } catch (e) {
    throw new NetGuardError("net_failed", `cannot resolve ${host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!records.length) throw new NetGuardError("net_failed", `${host} has no address`);
  for (const r of records) {
    const cls = classifyAddress(r.address);
    if (cls && !hostAllowed && !allowed(allow, [r.address], port)) {
      throw new NetGuardError("net_blocked", `${host} resolves to ${r.address}, a ${cls} address; private addresses are blocked`, BLOCKED_HINT);
    }
  }
  const first = records[0]!;
  return { host, address: first.address, family: first.family === 6 ? 6 : 4, port };
}

/** A `lookup` that always answers with the checked address: the socket connects there and nowhere else. */
export function pinnedLookup(target: Target): LookupFunction {
  return ((_host: string, options: { all?: boolean } | number | undefined, cb: (...args: unknown[]) => void) => {
    const callback = typeof options === "function" ? (options as (...args: unknown[]) => void) : cb;
    const all = typeof options === "object" && options?.all;
    if (all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  }) as unknown as LookupFunction;
}

export interface PublicRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface PublicResponse {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
  /** Every address the request went through, for the journal. */
  redirects: string[];
}

export const PUBLIC_LIMITS = { timeoutMs: 20_000, maxTimeoutMs: 60_000, maxBytes: 5_000_000, maxMaxBytes: 20_000_000, maxRedirects: 5, maxMaxRedirects: 10 };
const DROP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "proxy-authorization", "proxy-connection", "upgrade", "te", "keep-alive"]);

function clamp(v: unknown, def: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : def;
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetGuardError("bad_request", "url is not valid", BLOCKED_HINT);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NetGuardError("net_blocked", `only http and https, not ${url.protocol}`, BLOCKED_HINT);
  return url;
}

/** Resolves and checks an http(s) url without connecting (the browser preflight). */
export async function checkPublicUrl(rawUrl: string, opts: GuardOptions = {}): Promise<Target> {
  const url = checkUrl(rawUrl);
  return resolvePublic(url.hostname, url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80, opts);
}

/**
 * GET/HEAD/POST to the public internet. Redirects are followed here, each one resolved and checked again; the socket
 * always goes to the address that passed the check.
 */
export async function publicFetch(rawUrl: string, req: PublicRequest = {}, opts: GuardOptions = {}): Promise<PublicResponse> {
  const timeoutMs = clamp(req.timeoutMs, PUBLIC_LIMITS.timeoutMs, PUBLIC_LIMITS.maxTimeoutMs);
  const maxBytes = clamp(req.maxBytes, PUBLIC_LIMITS.maxBytes, PUBLIC_LIMITS.maxMaxBytes);
  const maxRedirects = req.maxRedirects === 0 ? 0 : clamp(req.maxRedirects, PUBLIC_LIMITS.maxRedirects, PUBLIC_LIMITS.maxMaxRedirects);
  let method = (req.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) throw new NetGuardError("bad_request", `method ${method} is not allowed`);
  let body: Buffer | undefined = req.body === undefined || req.body === null ? undefined : Buffer.from(req.body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) if (!DROP_REQUEST_HEADERS.has(k.toLowerCase()) && typeof v === "string") headers[k.toLowerCase()] = v;
  headers["user-agent"] ??= "Sinty/1.0";
  headers["accept-encoding"] = "gzip, deflate, br";
  const deadline = Date.now() + timeoutMs;
  const redirects: string[] = [];
  let url = checkUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const target = await resolvePublic(url.hostname, port, opts);
    if (Date.now() > deadline) throw new NetGuardError("timeout", `no answer from ${url.host} within ${timeoutMs} ms`);
    const res = await once(url, target, method, headers, body, deadline);
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && location) {
      res.resume();
      if (hop >= maxRedirects) throw new NetGuardError("net_failed", `more than ${maxRedirects} redirects`);
      const next = checkUrl(new URL(location, url).toString());
      if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
      }
      if (next.origin !== url.origin) {
        delete headers.authorization;
        delete headers.cookie;
      }
      redirects.push(next.toString());
      url = next;
      continue;
    }
    const bytes = method === "HEAD" ? new Uint8Array() : await readBody(res, maxBytes, deadline);
    const out: [string, string][] = [];
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      const k = res.rawHeaders[i]!.toLowerCase();
      if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding" || k === "connection") continue;
      out.push([k, res.rawHeaders[i + 1]!]);
    }
    return { url: url.toString(), status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: out, body: bytes, redirects };
  }
}

function once(url: URL, target: Target, method: string, headers: Record<string, string>, body: Buffer | undefined, deadline: number): Promise<IncomingMessage> {
  return new Promise((resolveRes, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const isName = !parseIPv4(target.host) && !parseIPv6(target.host);
    const r = mod.request(
      {
        protocol: url.protocol,
        host: target.host.includes(":") ? target.address : target.host,
        port: target.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, host: url.host, ...(body ? { "content-length": String(body.length) } : {}) },
        lookup: pinnedLookup(target),
        agent: false,
        ...(url.protocol === "https:" && isName ? { servername: target.host } : {}),
        timeout: Math.max(1, deadline - Date.now()),
      },
      resolveRes,
    );
    // The socket must land on the checked address, whatever the stack did.
    r.on("socket", (s) =>
      s.once("connect", () => {
        const remote = (s as net.Socket).remoteAddress;
        if (remote && ipKey(remote) !== ipKey(target.address)) r.destroy(new NetGuardError("net_blocked", `connected to ${remote}, expected ${target.address}`, BLOCKED_HINT));
      }),
    );
    r.on("timeout", () => r.destroy(new NetGuardError("timeout", `no answer from ${url.host} in time`)));
    r.on("error", (e) => reject(e instanceof NetGuardError ? e : new NetGuardError("net_failed", `${url.host}: ${e.message}`)));
    r.end(body);
  });
}

function readBody(res: IncomingMessage, maxBytes: number, deadline: number): Promise<Uint8Array> {
  return new Promise((resolveBody, reject) => {
    const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
    const stream: NodeJS.ReadableStream =
      enc === "gzip" || enc === "x-gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
    const chunks: Buffer[] = [];
    let size = 0;
    let raw = 0;
    const timer = setTimeout(() => fail(new NetGuardError("timeout", "the body did not arrive in time")), Math.max(1, deadline - Date.now()));
    const fail = (e: Error): void => {
      clearTimeout(timer);
      res.destroy();
      reject(e);
    };
    res.on("data", (c: Buffer) => {
      raw += c.length;
      if (raw > maxBytes * 4) fail(new NetGuardError("too_large", `response is larger than ${maxBytes} bytes`));
    });
    stream.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) return fail(new NetGuardError("too_large", `response is larger than ${maxBytes} bytes`));
      chunks.push(c);
    });
    stream.on("end", () => {
      clearTimeout(timer);
      resolveBody(new Uint8Array(Buffer.concat(chunks)));
    });
    stream.on("error", (e: Error) => fail(new NetGuardError("net_failed", `bad response body: ${e.message}`)));
    res.on("error", (e: Error) => fail(new NetGuardError("net_failed", e.message)));
  });
}

// ---- browser proxy ----

export interface GuardProxy {
  server: string;
  username: string;
  password: string;
  close(): Promise<void>;
}

/**
 * An HTTP proxy on 127.0.0.1 for one plugin process. CONNECT tunnels and plain http requests are both resolved and
 * checked like publicFetch and then connected to the checked address. Requests need the proxy credential.
 * `options()` is read on every connection, so an allowlist change in Settings applies at once.
 */
export async function startGuardProxy(options: () => GuardOptions, log?: (msg: string) => void): Promise<GuardProxy> {
  const username = "sinty";
  const password = randomBytes(18).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const authorized = (h: string | undefined): boolean => {
    const got = Buffer.from(h ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    if (!authorized(req.headers["proxy-authorization"])) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="sinty"', connection: "close" }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error("only http");
    } catch {
      res.writeHead(400, { connection: "close" }).end("absolute http url expected");
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    resolvePublic(url.hostname, port, options())
      .then((target) => {
        const headers: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined || k === "proxy-authorization" || k === "proxy-connection" || k === "connection" || k === "keep-alive") continue;
          headers[k] = v;
        }
        headers.host = url.host;
        const up = http.request({ host: target.host.includes(":") ? target.address : target.host, port, path: `${url.pathname}${url.search}`, method: req.method, headers, lookup: pinnedLookup(target), agent: false }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.rawHeaders);
          r.pipe(res);
        });
        up.on("error", () => res.headersSent ? res.destroy() : res.writeHead(502).end());
        req.pipe(up);
      })
      .catch((e: unknown) => {
        log?.(`proxy refused http ${url.host}: ${e instanceof Error ? e.message : String(e)}`);
        res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end(e instanceof Error ? e.message : "blocked");
      });
  });
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    if (!authorized(req.headers["proxy-authorization"])) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="sinty"\r\nConnection: close\r\n\r\n');
      return;
    }
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!m) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const port = Number(m[2]);
    resolvePublic(m[1]!, port, options())
      .then((target) => {
        const up = net.connect({ host: target.address, port, family: target.family });
        sockets.add(up);
        up.on("close", () => sockets.delete(up));
        up.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) up.write(head);
          up.pipe(client);
          client.pipe(up);
        });
        up.on("error", () => {
          if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        });
        client.on("close", () => up.destroy());
      })
      .catch((e: unknown) => {
        log?.(`proxy refused CONNECT ${req.url}: ${e instanceof Error ? e.message : String(e)}`);
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok());
  });
  const addr = server.address() as net.AddressInfo;
  return {
    server: `http://127.0.0.1:${addr.port}`,
    username,
    password,
    close: () =>
      new Promise<void>((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}
