import assert from "node:assert/strict";
import { test } from "node:test";
import { CURATED_MCP, curatedById, curatedInstallBody } from "./catalog.ts";

test("CURATED_MCP: Max-confirmed ids only, no excluded web cards", () => {
  const ids = CURATED_MCP.map((c) => c.id);
  assert.deepEqual(ids, [
    "github",
    "postgres",
    "mysql",
    "supabase",
    "sqlite",
    "filesystem",
    "telegram",
    "max-messenger",
    "memory",
  ]);
  for (const bad of ["fetch", "playwright", "brave", "slack", "calendar"]) {
    assert.equal(ids.some((id) => id.includes(bad)), false, `must not include ${bad}`);
  }
});

test("each entry has installable shape and secret:// env only", () => {
  for (const e of CURATED_MCP) {
    assert.match(e.id, /^[a-z][a-z0-9-]{1,63}$/);
    assert.ok(e.title && e.summary);
    if (e.runtime === "mcp-stdio") {
      assert.ok(e.command && e.command.length >= 1);
      assert.equal(e.command[0], "npx");
    } else {
      assert.ok(e.url?.startsWith("http"));
    }
    if (e.envHints) {
      for (const [k, v] of Object.entries(e.envHints)) {
        assert.match(k, /^[A-Z][A-Z0-9_]*$/);
        assert.match(v, /^secret:\/\/[A-Za-z][A-Za-z0-9._-]{0,63}$/);
      }
    }
    const body = curatedInstallBody(e);
    assert.equal(body.name, e.id);
    assert.equal(body.runtime, e.runtime);
  }
});

test("curatedById + install body for github", () => {
  const g = curatedById("github");
  assert.ok(g);
  const body = curatedInstallBody(g!);
  assert.deepEqual(body.command, ["npx", "-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(body.env, { GITHUB_PERSONAL_ACCESS_TOKEN: "secret://github.token" });
});

test("max-messenger uses real @woyax package", () => {
  const m = curatedById("max-messenger");
  assert.ok(m?.command?.includes("@woyax/mcp-max-messenger"));
  assert.equal(m?.envHints?.MAX_TOKEN, "secret://max.token");
});

test("filesystem note documents UI split", () => {
  const f = curatedById("filesystem");
  assert.ok(f?.note && (f.note.includes("follow-up") || f.note.includes("браузер")));
});

test("memory uses @modelcontextprotocol/server-memory", () => {
  const m = curatedById("memory");
  assert.ok(m?.command?.includes("@modelcontextprotocol/server-memory"));
});
