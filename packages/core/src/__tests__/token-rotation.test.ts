import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { rotateApiToken, TokenRotationError } from "../api-token.js";
import { policySchema } from "../config.js";
import { SecretStore } from "../secrets.js";
import { boot, tempHome } from "./helpers.js";

// Tokens here are throwaway values from temp homes; assertions compare them without echoing them.

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test("token rotation: POST /v1/auth/rotate gives a new token, the old one gets 401 at once", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { policy: policySchema.parse({}) });
  try {
    const app = createApp(sinty);
    const old = sinty.secrets.get("api.token")!;
    assert.equal((await app.request("/v1/sessions", { headers: bearer(old) })).status, 200);
    assert.equal((await app.request("/v1/auth/rotate", { method: "POST" })).status, 401, "rotation needs the current token");

    const res = await app.request("/v1/auth/rotate", { method: "POST", headers: bearer(old) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const { token } = (await res.json()) as { token: string };
    assert.ok(/^snt_[A-Za-z0-9_-]{32}$/.test(token), "new token has the snt_ shape");
    assert.ok(token !== old, "new token differs from the old one");
    assert.ok(sinty.secrets.get("api.token") === token, "stored as api.token");

    assert.equal((await app.request("/v1/sessions", { headers: bearer(old) })).status, 401);
    assert.equal((await app.request("/v1/sessions?token=" + encodeURIComponent(old))).status, 401);
    assert.equal((await app.request("/v1/sessions", { headers: bearer(token) })).status, 200);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("token rotation: an open event stream with the old token ends with auth.revoked", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { policy: policySchema.parse({}) });
  try {
    const app = createApp(sinty);
    const old = sinty.secrets.get("api.token")!;
    const stream = await app.request("/v1/stream", { headers: { ...bearer(old), accept: "text/event-stream" } });
    assert.equal(stream.status, 200);
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    const other = await app.request("/v1/stream", { headers: { ...bearer(old), accept: "text/event-stream" } });

    const rotated = await app.request("/v1/auth/rotate", { method: "POST", headers: bearer(old) });
    assert.equal(rotated.status, 200);
    const { token } = (await rotated.json()) as { token: string };

    let text = "";
    const deadline = Date.now() + 5000;
    for (;;) {
      const next = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now())).unref())]);
      if (next.done) break;
      text += next.value;
    }
    assert.match(text, /event: auth\.revoked/);
    assert.ok(Date.now() < deadline, "the stream ended by itself");
    await other.body?.cancel();

    // A stream opened with the new token is not cut by its own rotation check.
    const fresh = await app.request("/v1/stream", { headers: { ...bearer(token), accept: "text/event-stream" } });
    assert.equal(fresh.status, 200);
    await fresh.body?.cancel();
    assert.equal((await app.request("/v1/stream", { headers: bearer(old) })).status, 401);
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("token rotation from another process (the CLI) takes effect in a running server and is not overwritten by it", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { policy: policySchema.parse({}) });
  try {
    const app = createApp(sinty);
    const old = sinty.secrets.get("api.token")!;
    assert.equal((await app.request("/v1/sessions", { headers: bearer(old) })).status, 200);

    // `sinty token rotate`: its own SecretStore over the same files.
    const cli = new SecretStore(sinty.paths);
    const token = rotateApiToken(cli, sinty.config);

    assert.equal((await app.request("/v1/sessions", { headers: bearer(old) })).status, 401, "old token rejected without a restart");
    assert.equal((await app.request("/v1/sessions", { headers: bearer(token) })).status, 200);

    // The server writes another secret afterwards; before the fix it persisted its stale copy of api.token.
    sinty.secrets.set("some.key", "value-123456");
    const reread = new SecretStore(sinty.paths);
    assert.ok(reread.get("api.token") === token, "server write kept the rotated token");
    assert.equal(reread.get("some.key"), "value-123456");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("token rotation refuses a literal server.token and an environment override", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [], { policy: policySchema.parse({}) });
  try {
    const app = createApp(sinty);
    const literal = "literal-login-value";
    sinty.config.server.token = literal;
    const res = await app.request("/v1/auth/rotate", { method: "POST", headers: bearer(literal) });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "token_literal");
    assert.equal((await app.request("/v1/sessions", { headers: bearer(literal) })).status, 200, "literal token still works");

    sinty.config.server.token = "secret://api.token";
    process.env.SINTY_SECRET_API_TOKEN = "env-login-value";
    try {
      assert.throws(() => rotateApiToken(sinty.secrets, sinty.config), (e: unknown) => e instanceof TokenRotationError && e.code === "token_env");
    } finally {
      delete process.env.SINTY_SECRET_API_TOKEN;
    }
  } finally {
    await sinty.stop();
    cleanup();
  }
});
