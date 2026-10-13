import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { policySchema } from "../config.js";
import { resolvePaths } from "../paths.js";
import { checkFsGrant, evaluateTool, hostAllowed } from "../policy.js";

test("policy: exact rule beats glob, glob beats defaults, deny wins over agent allow", () => {
  const p = policySchema.parse({
    tools: { "fs.*": "ask", "fs.read": "allow", "shell.*": "deny" },
    agents: { designer: { tools: { "shell.run": "allow" } } },
  });
  assert.equal(evaluateTool(p, "fs.read", "read").decision, "allow");
  assert.equal(evaluateTool(p, "fs.write", "write").decision, "ask");
  assert.equal(evaluateTool(p, "web.fetch", "external").decision, "ask");
  assert.equal(evaluateTool(p, "echo.say", "none").decision, "allow");
  assert.equal(evaluateTool(p, "shell.run", "external", "designer").decision, "deny");
});

test("fs grants may not touch core-owned files", () => {
  const paths = resolvePaths(join("/tmp", "sinty-home"));
  assert.equal(checkFsGrant(paths, paths.workspace, "write"), undefined);
  assert.match(checkFsGrant(paths, paths.home, "write") ?? "", /overlaps/);
  assert.match(checkFsGrant(paths, paths.config, "read") ?? "", /overlaps/);
  assert.match(checkFsGrant(paths, paths.install, "write") ?? "", /overlaps/);
  assert.equal(checkFsGrant(paths, paths.install, "read"), undefined);
});

test("host allowlist supports wildcards", () => {
  assert.ok(hostAllowed("api.syntet.ru", ["*.syntet.ru"]));
  assert.ok(!hostAllowed("syntet.ru.evil.com", ["*.syntet.ru"]));
  assert.ok(hostAllowed("anything", ["*"]));
});
