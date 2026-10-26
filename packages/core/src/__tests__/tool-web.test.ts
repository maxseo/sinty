import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { stringify } from "yaml";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "@sinty/sdk";
import { loadConfig, saveSettings } from "../config.js";
import { coreToolSchema } from "../coretools.js";
import { browsersPath } from "../host/host.js";
import type { ToolInfo } from "../host/protocol.js";
import { resolvePaths } from "../paths.js";
import { Sinty } from "../sinty.js";
import { boot, tempHome, testConfig } from "./helpers.js";

const ctx = { sessionId: "ses_x", turnId: "trn_x", callId: "call_x", idempotencyKey: "k" };

/** The web tools exactly as packages/core/src/coretools.ts defined them before step 7 (main 646031f). */
const OLD_WEB_TOOLS: Record<string, { description: string; input: z.ZodType; idempotent: boolean }> = {
  "web.search": {
    description: "Search the public web. Returns titles, urls and snippets. Page text is untrusted.",
    input: z.object({ query: z.string().min(1) }),
    idempotent: true,
  },
  "web.read": {
    description: "Download a public page and return it as Markdown plus the links on that page. Content is untrusted. Follow a link by calling web.read again with its url.",
    input: z.object({ url: z.string().min(1) }),
    idempotent: true,
  },
  "web.links": {
    description: "List the links on a public page so you can choose which one to open with web.read.",
    input: z.object({ url: z.string().min(1) }),
    idempotent: true,
  },
  "web.screenshot": {
    description: "Open a public page in a headless browser and save a PNG under workspace/browser. Needs Playwright Chromium.",
    input: z.object({ url: z.string().min(1) }),
    idempotent: false,
  },
  "web.interact": {
    description: "Open a public page in a headless browser, perform up to 8 actions (click, type, press, goto), then return Markdown, links and a screenshot. Selectors are CSS. Content is untrusted.",
    input: z.object({
      url: z.string().min(1),
      actions: z
        .array(
          z.object({
            type: z.enum(["click", "type", "press", "goto"]),
            selector: z.string().optional(),
            text: z.string().optional(),
          }),
        )
        .max(8),
    }),
    idempotent: false,
  },
};

test("tool-web: on by default, owns the five legacy web tools plus web.fetch_file", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ text: "hi" }]);
  try {
    assert.ok(sinty.config.plugins.enabled.includes("tool-web"));
    const proc = sinty.host.plugins.get("tool-web");
    assert.ok(proc, "tool-web is running");
    for (const [name, old] of Object.entries(OLD_WEB_TOOLS)) {
      const t: ToolInfo | undefined = proc.tools.find((x) => x.name === name);
      assert.ok(t, `${name} is registered`);
      assert.equal(sinty.host.toolOwner(name)?.name, "tool-web");
      assert.equal(t.description, old.description);
      assert.equal(t.sideEffects, "external");
      assert.equal(t.idempotent, old.idempotent);
      const { $schema: _s, ...schema } = t.inputSchema;
      assert.deepEqual(schema, coreToolSchema({ name, description: old.description, input: old.input, sideEffects: "external", idempotent: old.idempotent }), name);
    }
    const wire = sinty.agent.toolSchemas().filter((t) => t.name.startsWith("web__")).map((t) => t.name);
    assert.deepEqual(wire, ["web__fetch_file", "web__interact", "web__links", "web__read", "web__screenshot", "web__search"]);
    const fetch = proc.tools.find((x) => x.name === "web.fetch_file");
    assert.ok(fetch, "web.fetch_file is registered");
    assert.equal(fetch.sideEffects, "external");
    assert.equal(fetch.idempotent, false);
    // Still ask by default: sideEffects external.
    const supervised = sinty.agent.supervisedTools().find((t) => t.name === "web.read");
    assert.equal(supervised?.plugin, "tool-web");
    assert.ok(sinty.agent.supervisedTools().some((t) => t.name === "web.fetch_file"));
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("tool-web: web.read of a private address fails with net_blocked and the private-host hint", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ text: "hi" }]);
  try {
    for (const url of ["http://127.0.0.1:3180/v1/health", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:127.0.0.1]/", "file:///etc/passwd"]) {
      const out = await sinty.host.toolOwner("web.read")!.callTool("web.read", { url }, ctx, {});
      assert.equal(out.ok, false, url);
      if (!out.ok) {
        assert.equal(out.error.code, "net_blocked", url);
        assert.equal(out.error.hint, "Only public http(s) pages. Private hosts are blocked.");
      }
    }
    const shot = await sinty.host.toolOwner("web.screenshot")!.callTool("web.screenshot", { url: "http://localhost:1/" }, ctx, {});
    assert.equal(shot.ok, false);
    if (!shot.ok) assert.match(shot.error.message, /local host localhost is blocked/);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("tool-web: plugins.disabled turns it off; Settings writes plugins.disabled and never rewrites the rest", async () => {
  const { home, cleanup } = tempHome();
  const paths = resolvePaths(home);
  try {
    // A config.yaml from before step 7: tool-web is not listed, the web tools still come.
    writeFileSync(paths.config, stringify({ models: { default: "fake/m" }, providers: { fake: { protocol: "fake" } }, plugins: { enabled: ["fake-provider", "tool-fs"] } }));
    assert.deepEqual(loadConfig(paths).plugins.enabled, ["fake-provider", "tool-fs", "tool-web", "tool-vision", "skills", "responsive-turn", "mcp-catalog"]);
    assert.ok(!readFileSync(paths.config, "utf8").includes("tool-web"), "loading does not write config.yaml");

    saveSettings(paths, { model: "fake/m", fallback: [], enabled: ["fake-provider", "tool-fs", "skills", "responsive-turn", "mcp-catalog", "tool-vision"] }, { fake: {} });
    assert.deepEqual(loadConfig(paths).plugins.disabled, ["tool-web"]);
    assert.ok(!loadConfig(paths).plugins.enabled.includes("tool-web"));

    saveSettings(paths, { model: "fake/m", fallback: [], enabled: ["fake-provider", "tool-fs", "tool-web", "tool-vision", "skills", "responsive-turn", "mcp-catalog"] }, { fake: {} });
    assert.equal(loadConfig(paths).plugins.disabled, undefined);
    assert.ok(loadConfig(paths).plugins.enabled.includes("tool-web"));
  } finally {
    cleanup();
  }
  const second = tempHome();
  const base = testConfig([{ text: "hi" }]);
  const sinty = new Sinty({ home: second.home, config: { ...base, plugins: { ...base.plugins!, disabled: ["tool-web"] } } });
  try {
    await sinty.start();
    assert.equal(sinty.host.plugins.get("tool-web"), undefined);
    assert.equal(sinty.host.toolOwner("web.read"), undefined);
  } finally {
    await sinty.stop();
    second.cleanup();
  }
});

test("tool-web: another plugin cannot take a web.* name", async () => {
  const { home, cleanup } = tempHome();
  const sinty = new Sinty({ home, config: testConfig([{ text: "hi" }], {}, ["fake-provider", "web-squatter"]) });
  try {
    const { failedPlugins } = await sinty.start();
    const failed = failedPlugins.find((f) => f.plugin === "web-squatter");
    assert.ok(failed);
    assert.match(failed.error, /web\.read \(tool-web\) is reserved for a bundled plugin/);
    assert.equal(sinty.host.toolOwner("web.read")?.name, "tool-web");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("ctx.net.public: needs $PUBLIC, blocks loopback, honours the human's allowPrivate, raw fetch stays closed", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/hop") res.writeHead(302, { location: "http://169.254.169.254/" }).end();
    else res.writeHead(200, { "content-type": "text/plain" }).end("hello");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ text: "hi" }], { plugins: ["fake-provider", "net-public", "net-nopublic"] });
  const call = async (tool: string, args: unknown) => sinty.host.toolOwner(tool)!.callTool(tool, args, ctx, {});
  try {
    const url = `http://127.0.0.1:${port}/`;
    const denied = await call("nopub.get", { url });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "net_denied");

    const blockedOut = await call("net.get", { url });
    assert.equal(blockedOut.ok, false);
    if (!blockedOut.ok) assert.equal(blockedOut.error.code, "net_blocked");
    const checked = await call("net.check", { url: "http://[fe80::1]/" });
    assert.equal(checked.ok, false);

    // The human allows it in config.yaml (Settings writes plugins.config.net-public.allowPrivate); applies at once.
    sinty.config.plugins.config["net-public"] = { allowPrivate: `127.0.0.1:${port}` };
    const ok = await call("net.get", { url });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    if (ok.ok) assert.deepEqual(ok.content, { status: 200, url, text: "hello", type: "text/plain" });
    const hop = await call("net.get", { url: `${url}hop` });
    assert.equal(hop.ok, false, "the redirect target is checked too");
    if (!hop.ok) assert.equal(hop.error.code, "net_blocked");

    const raw = await call("net.raw", { url: "https://example.com/" });
    assert.equal(raw.ok, false);
    if (!raw.ok) assert.equal(raw.error.code, "net_denied");
    const proxy = await call("net.proxy", {});
    assert.equal(proxy.ok, false, "no browser proxy without permissions.browser");
    if (!proxy.ok) assert.equal(proxy.error.code, "net_denied");
  } finally {
    await sinty.stop();
    cleanup();
    srv.close();
  }
});

test("tool-web: big pages are read and marked [truncated]; site errors get http codes and fitting hints; browser headers", async () => {
  const seen: { ua: string | undefined; lang: string | undefined; accept: string | undefined }[] = [];
  const big = `<html><head><title>Маркет</title></head><body><h1>PS5 Pro</h1><p>79 990 ₽</p>${"<div class=\"x\">".repeat(30_000)}</body></html>`;
  const srv = createServer((req, res) => {
    seen.push({ ua: req.headers["user-agent"], lang: req.headers["accept-language"], accept: req.headers.accept });
    const status = Number(req.url?.slice(1)) || 200;
    if (req.url === "/big") res.writeHead(200, { "content-type": "text/html" }).end(big);
    else res.writeHead(status, { "content-type": "text/html" }).end("<html><title>err</title></html>");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  const { home, cleanup } = tempHome();
  const base = testConfig([{ text: "hi" }]);
  const sinty = new Sinty({ home, config: { ...base, plugins: { ...base.plugins!, config: { "tool-web": { allowPrivate: `127.0.0.1:${port}`, maxPageKb: 100 } } } } });
  const read = (path: string) => sinty.host.toolOwner("web.read")!.callTool("web.read", { url: `http://127.0.0.1:${port}${path}` }, ctx, {});
  try {
    await sinty.start();
    assert.ok(big.length > 400_000);
    const out = await read("/big");
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
    if (out.ok) {
      const c = out.content as { title: string; markdown: string; truncated?: boolean };
      assert.equal(c.title, "Маркет");
      assert.match(c.markdown, /PS5 Pro[\s\S]*79 990 ₽/);
      assert.match(c.markdown, /…\[truncated\]$/);
      assert.equal(c.truncated, true);
    }
    const PRIVATE = /Private hosts/;
    const cases: [string, string, RegExp][] = [
      ["/401", "http_4xx", /anti-bot[\s\S]*web\.interact/],
      ["/403", "http_4xx", /anti-bot[\s\S]*web\.interact/],
      ["/429", "http_4xx", /rate-limits[\s\S]*web\.interact/],
      ["/404", "http_4xx", /web\.search or web\.links/],
      ["/503", "http_5xx", /server error/],
    ];
    for (const [path, code, hint] of cases) {
      const r = await read(path);
      assert.equal(r.ok, false, path);
      if (!r.ok) {
        assert.equal(r.error.code, code, path);
        assert.match(r.error.message, new RegExp(`page returned ${path.slice(1)}.*\\(127\\.0\\.0\\.1:${port}\\)`), path);
        assert.match(r.error.hint ?? "", hint, path);
        assert.doesNotMatch(r.error.hint ?? "", PRIVATE, path);
      }
    }
    assert.ok(seen.every((h) => /^Mozilla\/5\.0 .*Chrome\//.test(h.ua ?? "")), JSON.stringify(seen[0]));
    assert.ok(seen.every((h) => h.lang?.startsWith("ru-RU") && h.accept?.startsWith("text/html")), JSON.stringify(seen[0]));
  } finally {
    await sinty.stop();
    cleanup();
    srv.close();
  }
});

function hasChromium(): boolean {
  try {
    return readdirSync(browsersPath()).some((d) => d.startsWith("chromium"));
  } catch {
    return false;
  }
}

test("tool-web: the browser goes through the core proxy; a page cannot reach loopback behind it", { skip: hasChromium() ? false : "Playwright Chromium is not installed" }, async () => {
  const hits: string[] = [];
  const leak = createServer((req, res) => {
    hits.push(`leak ${req.url}`);
    res.end("x");
  });
  await new Promise<void>((r) => leak.listen(0, "127.0.0.1", () => r()));
  const leakPort = (leak.address() as AddressInfo).port;
  const page = createServer((req, res) => {
    hits.push(`page ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>Local</title></head><body><h1>Hi</h1><input id="q"><img src="http://127.0.0.1:${leakPort}/img.png"><img src="http://localhost:${leakPort}/img2.png"><script>fetch("http://[::1]:${leakPort}/js").catch(()=>{})</script></body></html>`);
  });
  await new Promise<void>((r) => page.listen(0, "127.0.0.1", () => r()));
  const pagePort = (page.address() as AddressInfo).port;
  const { home, cleanup } = tempHome();
  const base = testConfig([{ text: "hi" }]);
  const sinty = new Sinty({ home, config: { ...base, plugins: { ...base.plugins!, config: { "tool-web": { allowPrivate: `127.0.0.1:${pagePort}` } } } } });
  try {
    await sinty.start();
    const out = await sinty.host.toolOwner("web.interact")!.callTool("web.interact", { url: `http://127.0.0.1:${pagePort}/`, actions: [{ type: "type", selector: "#q", text: "tea" }] }, ctx, { timeoutMs: 120_000 });
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) {
      const c = out.content as { title: string; screenshot: string };
      assert.equal(c.title, "Local");
      assert.ok(existsSync(c.screenshot));
    }
    assert.deepEqual(hits, ["page /"], "only the allow-listed page was reached");
    const go = await sinty.host.toolOwner("web.interact")!.callTool("web.interact", { url: `http://127.0.0.1:${pagePort}/`, actions: [{ type: "goto", text: `http://127.0.0.1:${leakPort}/` }] }, ctx, { timeoutMs: 120_000 });
    assert.equal(go.ok, false);
    assert.ok(!hits.some((h) => h.startsWith("leak")));
  } finally {
    await sinty.stop();
    cleanup();
    leak.close();
    page.close();
  }
});

test("tool-web: web.interact and web.screenshot return the HTTP status and flag captcha pages", { skip: hasChromium() ? false : "Playwright Chromium is not installed" }, async () => {
  const page = createServer((req, res) => {
    if (req.url === "/captcha") res.writeHead(403, { "content-type": "text/html" }).end("<html><head><title>Ой!</title></head><body>Слишком много запросов с вашего IP. Подтвердите, что вы не робот.</body></html>");
    else if (req.url === "/robot") res.writeHead(200, { "content-type": "text/html" }).end("<html><head><title>Вы не робот?</title></head><body>SmartCaptcha</body></html>");
    else res.writeHead(200, { "content-type": "text/html" }).end("<html><head><title>PS5</title></head><body><h1>PS5 Pro</h1></body></html>");
  });
  await new Promise<void>((r) => page.listen(0, "127.0.0.1", () => r()));
  const port = (page.address() as AddressInfo).port;
  const { home, cleanup } = tempHome();
  const base = testConfig([{ text: "hi" }]);
  const sinty = new Sinty({ home, config: { ...base, plugins: { ...base.plugins!, config: { "tool-web": { allowPrivate: `127.0.0.1:${port}` } } } } });
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  try {
    await sinty.start();
    const interact = (u: string, actions: unknown[] = []) => sinty.host.toolOwner("web.interact")!.callTool("web.interact", { url: u, actions }, ctx, { timeoutMs: 120_000 });
    const ok = await interact(url("/"));
    assert.equal(ok.ok, true, JSON.stringify(ok));
    if (ok.ok) {
      const c = ok.content as { status?: number; blocked?: string };
      assert.equal(c.status, 200);
      assert.equal(c.blocked, undefined);
    }
    const cap = await interact(url("/"), [{ type: "goto", text: url("/captcha") }]);
    assert.equal(cap.ok, true, JSON.stringify(cap));
    if (cap.ok) {
      const c = cap.content as { status?: number; blocked?: string };
      assert.equal(c.status, 403, "the status of the last navigation");
      assert.match(c.blocked ?? "", /HTTP 403[\s\S]*Do not repeat/);
    }
    const shot = await sinty.host.toolOwner("web.screenshot")!.callTool("web.screenshot", { url: url("/robot") }, ctx, { timeoutMs: 120_000 });
    assert.equal(shot.ok, true, JSON.stringify(shot));
    if (shot.ok) {
      const c = shot.content as { status?: number; blocked?: string; path: string };
      assert.equal(c.status, 200);
      assert.match(c.blocked ?? "", /captcha/);
      assert.ok(existsSync(c.path));
    }
  } finally {
    await sinty.stop();
    cleanup();
    page.close();
  }
});

test("tool-web: the search parser can be repaired by a plugin patch; its tests gate the patch", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, []);
  try {
    const s = sinty.agent.createSession();
    const src = (sinty.patches.read("tool-web", "src/search.ts") as { content: string }).content;
    const broken = await sinty.patches.propose(s.id, { plugin: "tool-web", reason: "break the parser", files: [{ path: "src/search.ts", content: src.replaceAll("result__snippet", "result__nothing") }] });
    assert.equal(broken.status, "failed_tests", "search.test.ts catches a broken parser");
    assert.match(broken.testOutput, /src\/search\.test\.ts: FAIL/);

    const fixed = await sinty.patches.propose(s.id, { plugin: "tool-web", reason: "new DuckDuckGo markup", files: [{ path: "src/search.ts", content: `// parser updated\n${src}` }] });
    assert.equal(fixed.status, "ready", fixed.testOutput);
    assert.equal(fixed.permissionsChanged, false);
    assert.match(fixed.testOutput, /load: ok, tools \[web\.search, web\.read, web\.links, web\.screenshot, web\.interact, web\.fetch_file\]/);
    assert.equal((await sinty.patches.apply(fixed.id)).applied, true);
    assert.equal(sinty.host.plugins.get("tool-web")?.loaded.bundled, false);
    assert.equal(sinty.host.toolOwner("web.search")?.name, "tool-web");
    const out = await sinty.host.toolOwner("web.read")!.callTool("web.read", { url: "http://127.0.0.1/" }, ctx, {});
    assert.equal(out.ok, false, "the forked copy still goes through the core guard");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("tool-web: web.fetch_file writes under the project workspace and refuses escape", async () => {
  const payload = Buffer.from("fetch-file-bytes-ok");
  const srv = createServer((req, res) => {
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(3_000_000) });
      res.end(Buffer.alloc(3_000_000, 7));
      return;
    }
    res.writeHead(200, { "content-type": "application/pdf", "content-length": String(payload.length) });
    res.end(payload);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  const { home, cleanup } = tempHome();
  const base = testConfig([{ text: "hi" }]);
  const sinty = new Sinty({
    home,
    config: {
      ...base,
      plugins: { ...base.plugins!, config: { "tool-web": { allowPrivate: `127.0.0.1:${port}`, maxFetchMb: 1 } } },
    },
  });
  try {
    await sinty.start();
    const { saveProject, projectDir } = await import("../roster.js");
    const project = saveProject(sinty.paths, { name: "Fetch Demo" });
    const folder = projectDir(sinty.paths, project);
    const call = (args: Record<string, unknown>, workspace?: string) =>
      sinty.host.toolOwner("web.fetch_file")!.callTool("web.fetch_file", args, { ...ctx, ...(workspace ? { workspace } : {}) }, {});

    const ok = await call({ url: `http://127.0.0.1:${port}/doc.pdf`, path: "_out/doc.pdf" }, folder);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    if (ok.ok) {
      const c = ok.content as { path: string; bytes: number; contentType?: string; url: string };
      assert.equal(c.path, "_out/doc.pdf");
      assert.equal(c.bytes, payload.length);
      assert.match(c.contentType ?? "", /application\/pdf/);
      assert.equal(existsSync(join(folder, "_out", "doc.pdf")), true);
      assert.equal(readFileSync(join(folder, "_out", "doc.pdf")).equals(payload), true);
      assert.equal(existsSync(join(sinty.paths.workspace, "_out", "doc.pdf")), false, "must not write to global workspace");
    }

    const escape = await call({ url: `http://127.0.0.1:${port}/doc.pdf`, path: "../escape.bin" }, folder);
    assert.equal(escape.ok, false);
    if (!escape.ok) assert.equal(escape.error.code, "outside_workspace");

    const tooBig = await call({ url: `http://127.0.0.1:${port}/big`, path: "_out/big.bin" }, folder);
    assert.equal(tooBig.ok, false);
    if (!tooBig.ok) {
      assert.equal(tooBig.error.code, "too_large");
      assert.match(tooBig.error.hint ?? "", /maxFetchMb|download size/i);
    }
  } finally {
    await sinty.stop();
    cleanup();
    srv.close();
  }
});

test("tool-web: web.fetch_file without a project uses the global workspace", async () => {
  const payload = Buffer.from("global-fetch");
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" }).end(payload);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  const { home, cleanup } = tempHome();
  const base = testConfig([{ text: "hi" }]);
  const sinty = new Sinty({
    home,
    config: { ...base, plugins: { ...base.plugins!, config: { "tool-web": { allowPrivate: `127.0.0.1:${port}` } } } },
  });
  try {
    await sinty.start();
    const out = await sinty.host.toolOwner("web.fetch_file")!.callTool(
      "web.fetch_file",
      { url: `http://127.0.0.1:${port}/a.txt`, path: "_out/a.txt" },
      ctx,
      {},
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) {
      const c = out.content as { path: string; bytes: number };
      assert.equal(c.path, "_out/a.txt");
      assert.equal(c.bytes, payload.length);
      assert.equal(readFileSync(join(sinty.paths.workspace, "_out", "a.txt"), "utf8"), "global-fetch");
    }
  } finally {
    await sinty.stop();
    cleanup();
    srv.close();
  }
});
