import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../api/server.js";
import { Accounts } from "../accounts.js";
import { DEFAULT_ON_PLUGINS, type SintyConfig } from "../config.js";
import { boot, tempHome } from "./helpers.js";

const noDefaultPlugins = { plugins: ["fake-provider", "test-tools"] as string[], config: { plugins: { disabled: [...DEFAULT_ON_PLUGINS] } as SintyConfig["plugins"] } };


test("HTTP first-run setup is atomic, persists, and leaves other APIs protected", async () => {
  const { home, cleanup } = tempHome();
  const prevOrigin = process.env.SINTY_PUBLIC_ORIGIN;
  process.env.SINTY_PUBLIC_ORIGIN = "https://app.example.com";
  try {
    const sinty = await boot(home, [], noDefaultPlugins);
    try {
      const app = createApp(sinty);

      assert.equal((await app.request("/v1/sessions")).status, 401);
      assert.equal((await app.request("/v1/accounts/users")).status, 401);
      const needed = (await (await app.request("/v1/auth/setup")).json()) as { needed: boolean };
      assert.equal(needed.needed, true);

      const short = await app.request("/v1/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com", password: "short" }) });
      assert.equal(short.status, 400);
      assert.equal(((await (await app.request("/v1/auth/setup")).json()) as { needed: boolean }).needed, true);

      const cross = await app.request("/v1/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ email: "x@example.com", password: "secret-pass" }),
      });
      assert.equal(cross.status, 403);
      assert.equal(((await (await app.request("/v1/auth/setup")).json()) as { needed: boolean }).needed, true);

      const headers = { "content-type": "application/json", origin: "https://app.example.com" };
      const settled = await Promise.all([
        app.request("/v1/auth/setup", { method: "POST", headers, body: JSON.stringify({ email: "admin@example.com", password: "secret-pass", firstName: "Ann" }) }),
        app.request("/v1/auth/setup", { method: "POST", headers, body: JSON.stringify({ email: "other@example.com", password: "secret-pass" }) }),
      ]);
      const statuses = settled.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409]);
      const created = settled.find((r) => r.status === 201)!;
      const payload = (await created.json()) as { user: { email: string; system: boolean }; token: string };
      assert.equal(payload.user.email, "admin@example.com");
      assert.equal(payload.user.system, true);
      assert.equal(typeof payload.token, "string");
      assert.match(payload.token, /^snu_/);
      assert.equal(JSON.stringify(payload).includes("secret-pass"), false);

      assert.equal(((await (await app.request("/v1/auth/setup")).json()) as { needed: boolean }).needed, false);
      const second = await app.request("/v1/auth/setup", { method: "POST", headers, body: JSON.stringify({ email: "late@example.com", password: "secret-pass" }) });
      assert.equal(second.status, 409);
      assert.equal((await app.request("/v1/sessions")).status, 401);

      const me = await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${payload.token}` } });
      assert.equal(me.status, 200);
      const meBody = (await me.json()) as { kind: string; superadmin: boolean };
      assert.equal(meBody.kind, "user");
      assert.equal(meBody.superadmin, true);

      const login = await app.request("/v1/auth/login", { method: "POST", headers, body: JSON.stringify({ email: "admin@example.com", password: "secret-pass" }) });
      assert.equal(login.status, 200);
    } finally {
      await sinty.stop();
    }

    const again = await boot(home, [], noDefaultPlugins);
    try {
      const app = createApp(again);
      assert.equal(((await (await app.request("/v1/auth/setup")).json()) as { needed: boolean }).needed, false);
      const retry = await app.request("/v1/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "new@example.com", password: "secret-pass" }) });
      assert.equal(retry.status, 409);
      const accounts = new Accounts(again.paths.accounts);
      try {
        assert.equal(accounts.listUsers().length, 1);
        assert.equal(accounts.listUsers()[0]?.email, "admin@example.com");
      } finally {
        accounts.close();
      }
    } finally {
      await again.stop();
    }
  } finally {
    if (prevOrigin === undefined) delete process.env.SINTY_PUBLIC_ORIGIN;
    else process.env.SINTY_PUBLIC_ORIGIN = prevOrigin;
    cleanup();
  }
});
