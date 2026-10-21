import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { classifyAddress, isPrivateAddress } from "@sinty/sdk";
import { checkPublicUrl, NetGuardError, parseAllowPrivate, publicFetch, resolvePublic, startGuardProxy, type Resolver } from "../netguard.js";

const BLOCKED = [
  "127.0.0.1",
  "127.255.255.254",
  "10.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "100.127.255.255",
  "0.0.0.0",
  "0.1.2.3",
  "255.255.255.255",
  "224.0.0.1",
  "192.0.2.10",
  "::",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::FFFF:169.254.169.254",
  "::ffff:10.0.0.1",
  "::127.0.0.1",
  "64:ff9b::7f00:1",
  "2002:7f00:1::1",
  "fe80::1",
  "fe80::1%eth0",
  "febf::1",
  "fc00::1",
  "fd12:3456:789a::1",
  "fec0::1",
  "ff02::1",
  "2001:db8::1",
  "2001:0:4136:e378:8000:63bf:3fff:fdd2",
];
const PUBLIC = ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.169.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "198.18.0.1"]; // 198.18/15: fake-ip DNS of TUN proxies, see netaddr.ts

test("netguard: every private, loopback, link-local, CGNAT and IPv6 form is classified", () => {
  for (const ip of BLOCKED) assert.ok(isPrivateAddress(ip), `${ip} must be blocked (got ${classifyAddress(ip)})`);
  for (const ip of PUBLIC) assert.equal(classifyAddress(ip), undefined, `${ip} is public`);
  assert.equal(classifyAddress("169.254.169.254"), "link-local");
  assert.equal(classifyAddress("100.64.1.1"), "shared");
  assert.equal(classifyAddress("::ffff:127.0.0.1"), "loopback");
  assert.equal(classifyAddress("fd00::1"), "unique-local");
  assert.equal(classifyAddress("not-an-ip"), "invalid");
  assert.equal(classifyAddress("1.2.3"), "invalid");
  assert.equal(classifyAddress("01.2.3.4"), "invalid");
});

async function blocked(p: Promise<unknown>, re?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof NetGuardError, String(e));
    assert.equal(e.code, "net_blocked", e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test("netguard: literal urls in every spelling are refused before any connection", async () => {
  const urls = [
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://017700000001/",
    "http://127.1/",
    "http://0/",
    "http://[::1]:3180/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://localhost:3180/v1/health",
    "http://app.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "file:///etc/passwd",
    "ftp://example.com/",
  ];
  const resolve: Resolver = async () => {
    throw new Error("must not resolve");
  };
  for (const u of urls) await blocked(checkPublicUrl(u, { resolve }));
});

test("netguard: a name that resolves to 127.0.0.1 (or to any private address in the answer) is refused", async () => {
  await blocked(resolvePublic("evil.example", 80, { resolve: async () => [{ address: "127.0.0.1", family: 4 }] }), /resolves to 127\.0\.0\.1/);
  await blocked(resolvePublic("mixed.example", 80, { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }] }), /10\.0\.0\.7/);
  await blocked(resolvePublic("v6.example", 443, { resolve: async () => [{ address: "::ffff:127.0.0.1", family: 6 }] }));
  await blocked(resolvePublic("meta.example", 80, { resolve: async () => [{ address: "169.254.169.254", family: 4 }] }));
  const ok = await resolvePublic("good.example", 443, { resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  assert.deepEqual(ok, { host: "good.example", address: "93.184.216.34", family: 4, port: 443 });
});

test("netguard: allowPrivate entries are parsed and match host and port", async () => {
  assert.deepEqual(parseAllowPrivate("127.0.0.1:8080, nas.lan [::1]:9000\nfd00::5;"), [
    { host: "127.0.0.1", port: 8080 },
    { host: "nas.lan" },
    { host: "00000000000000000000000000000001", port: 9000 },
    { host: "fd000000000000000000000000000005" },
  ]);
  assert.deepEqual(parseAllowPrivate(["10.0.0.2", 5, "entry!:x"]), [{ host: "10.0.0.2" }]);
  assert.deepEqual(parseAllowPrivate(undefined), []);
  const allow = parseAllowPrivate("127.0.0.1:8080, nas.lan");
  await resolvePublic("127.0.0.1", 8080, { allow });
  await blocked(resolvePublic("127.0.0.1", 8081, { allow }));
  const nas = await resolvePublic("nas.lan", 80, { allow, resolve: async () => [{ address: "192.168.1.20", family: 4 }] });
  assert.equal(nas.address, "192.168.1.20");
  await blocked(resolvePublic("other.lan", 80, { allow, resolve: async () => [{ address: "192.168.1.20", family: 4 }] }));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

test("netguard: a redirect to a private address is refused, every hop is checked", async () => {
  const inner = await listen((_req, res) => res.end("secret"));
  const outer = await listen((req, res) => {
    const to: Record<string, string> = {
      "/meta": "http://169.254.169.254/latest/meta-data/",
      "/loop": `http://127.0.0.1:${inner.port}/`,
      "/v6": "http://[::ffff:127.0.0.1]/",
      "/name": "http://rebound.example/",
      "/file": "file:///etc/passwd",
      "/ok": "/final",
    };
    const loc = to[req.url ?? ""];
    if (loc) res.writeHead(302, { location: loc }).end();
    else res.end(`at ${req.url}`);
  });
  // The test server itself is on loopback, so only it is allow-listed; what it redirects to is not.
  const allow = parseAllowPrivate(`127.0.0.1:${outer.port}`);
  const resolve: Resolver = async (h) => (h === "rebound.example" ? [{ address: "127.0.0.1", family: 4 }] : []);
  try {
    for (const p of ["/meta", "/loop", "/v6", "/name", "/file"]) await blocked(publicFetch(`http://127.0.0.1:${outer.port}${p}`, {}, { allow, resolve }));
    const ok = await publicFetch(`http://127.0.0.1:${outer.port}/ok`, {}, { allow, resolve });
    assert.equal(Buffer.from(ok.body).toString(), "at /final");
    assert.equal(ok.url, `http://127.0.0.1:${outer.port}/final`);
    assert.deepEqual(ok.redirects, [`http://127.0.0.1:${outer.port}/final`]);
  } finally {
    outer.server.close();
    inner.server.close();
  }
});

test("netguard: the socket goes to the checked address; DNS is asked once per hop (no rebinding window)", async () => {
  let host = "";
  const srv = await listen((req, res) => {
    host = req.headers.host ?? "";
    res.end("pinned");
  });
  let lookups = 0;
  // "pinned.example" does not exist in real DNS; the request can only succeed by connecting to the pinned answer.
  const resolve: Resolver = async () => {
    lookups++;
    return [{ address: "127.0.0.1", family: 4 }];
  };
  try {
    const r = await publicFetch(`http://pinned.example:${srv.port}/`, {}, { allow: parseAllowPrivate(`pinned.example:${srv.port}`), resolve });
    assert.equal(Buffer.from(r.body).toString(), "pinned");
    assert.equal(lookups, 1);
    assert.equal(host, `pinned.example:${srv.port}`);
  } finally {
    srv.server.close();
  }
});

test("netguard: bodies are decoded and limited", async () => {
  const srv = await listen((req, res) => {
    if (req.url === "/gz") res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/html" }).end(gzipSync("<p>zipped</p>"));
    else res.end("x".repeat(10_000));
  });
  const allow = parseAllowPrivate(`127.0.0.1:${srv.port}`);
  try {
    const gz = await publicFetch(`http://127.0.0.1:${srv.port}/gz`, {}, { allow });
    assert.equal(Buffer.from(gz.body).toString(), "<p>zipped</p>");
    assert.ok(!gz.headers.some(([k]) => k === "content-encoding"));
    await assert.rejects(publicFetch(`http://127.0.0.1:${srv.port}/big`, { maxBytes: 1000 }, { allow }), (e: unknown) => e instanceof NetGuardError && e.code === "too_large");
  } finally {
    srv.server.close();
  }
});

test("netguard: truncate keeps the first maxBytes instead of failing; off by default", async () => {
  const page = `<html><title>Big</title><body>${"<p>item</p>".repeat(20_000)}</body></html>`;
  const srv = await listen((req, res) => {
    if (req.url === "/gz") res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/html" }).end(gzipSync(page));
    else res.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  const allow = parseAllowPrivate(`127.0.0.1:${srv.port}`);
  try {
    for (const path of ["/plain", "/gz"]) {
      const r = await publicFetch(`http://127.0.0.1:${srv.port}${path}`, { maxBytes: 5000, truncate: true }, { allow });
      assert.equal(r.truncated, true, path);
      assert.equal(r.body.length, 5000, path);
      assert.equal(Buffer.from(r.body).toString(), page.slice(0, 5000), path);
      await assert.rejects(publicFetch(`http://127.0.0.1:${srv.port}${path}`, { maxBytes: 5000 }, { allow }), (e: unknown) => e instanceof NetGuardError && e.code === "too_large", `${path}: binary/download uses keep the hard limit`);
    }
    const small = await publicFetch(`http://127.0.0.1:${srv.port}/plain`, { truncate: true }, { allow });
    assert.equal(small.truncated, false);
    assert.equal(small.body.length, page.length);
  } finally {
    srv.server.close();
  }
});

function rawConnect(proxyPort: number, request: string): Promise<string> {
  return new Promise((resolveText, reject) => {
    const s = connect(proxyPort, "127.0.0.1", () => s.write(request));
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) {
        s.destroy();
        resolveText(buf.split("\r\n")[0]!);
      }
    });
    s.on("error", reject);
    s.on("close", () => resolveText(buf.split("\r\n")[0] ?? ""));
  });
}

test("netguard: the browser proxy needs its credential and refuses private targets", async () => {
  const target = await listen((_req, res) => res.end("through"));
  let allow = parseAllowPrivate("");
  const proxy = await startGuardProxy(() => ({ allow }));
  const port = Number(new URL(proxy.server).port);
  const auth = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`;
  try {
    assert.match(await rawConnect(port, `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`), / 407 /);
    assert.match(await rawConnect(port, `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic d3Jvbmc6d3Jvbmc=\r\n\r\n`), / 407 /);
    for (const t of [`127.0.0.1:${target.port}`, "169.254.169.254:80", "[::1]:80", "[::ffff:127.0.0.1]:80", "localhost:80", "10.0.0.1:443"]) {
      assert.match(await rawConnect(port, `CONNECT ${t} HTTP/1.1\r\n${auth}\r\n`), / 403 /, t);
    }
    assert.match(await rawConnect(port, `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n${auth}\r\n`), / 403 /);
    // The allowlist is read on every connection: the human allows the target in Settings, it goes through at once.
    allow = parseAllowPrivate(`127.0.0.1:${target.port}`);
    assert.match(await rawConnect(port, `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\n${auth}\r\n`), / 200 /);
    assert.match(await rawConnect(port, `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n${auth}\r\n`), / 200 /);
  } finally {
    await proxy.close();
    target.server.close();
  }
});
