import assert from "node:assert/strict";
import test from "node:test";
import { visibleSkills } from "./index.ts";
import { DEFAULT_CATALOG_LIMIT, readSettings } from "./settings.ts";
import { skillCatalog } from "./skills.ts";

test("settings: catalogLimit defaults to 60 and is clamped to 1..500", () => {
  assert.equal(readSettings({}).catalogLimit, DEFAULT_CATALOG_LIMIT);
  assert.equal(readSettings({ catalogLimit: "12" }).catalogLimit, 12);
  assert.equal(readSettings({ catalogLimit: 0 }).catalogLimit, 1);
  assert.equal(readSettings({ catalogLimit: 9999 }).catalogLimit, 500);
  assert.equal(readSettings({ catalogLimit: "x" }).catalogLimit, DEFAULT_CATALOG_LIMIT);
});

test("catalog: an agent sees its ticked skills, the global persona all; past the limit skill.read still works by name", () => {
  const all = [
    { name: "bake", description: "Heat the oven first." },
    { name: "stew", description: "" },
  ];
  assert.deepEqual(visibleSkills(all, { sessionId: "s" }), all);
  assert.deepEqual(visibleSkills(all, { sessionId: "s", agent: { id: "a", name: "A", skills: ["stew"] } }), [all[1]]);
  assert.deepEqual(visibleSkills(all, { sessionId: "s", agent: { id: "a", name: "A", skills: [] } }), []);
  const text = skillCatalog(all, 1);
  assert.match(text, /- bake: Heat the oven first\.\n- …1 more; skill\.read still works by name$/);
  assert.match(skillCatalog([all[1]!]), /- stew: no description$/);
  assert.match(skillCatalog([]), /\(none\)$/);
});
