import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { editSkillFile, listSkillFiles, listSkills, readSkill, readSkillFile, skillCatalog, writeSkill, writeSkillFile } from "../skills.js";

test("skills: description from frontmatter, full text on read", () => {
  const root = mkdtempSync(join(tmpdir(), "sinty-skills-"));
  mkdirSync(join(root, "bake"));
  writeFileSync(join(root, "bake", "SKILL.md"), "---\nname: bake\ndescription: Heat the oven first.\n---\n# Bake\n\nStep one.\n");
  const list = listSkills(root);
  assert.equal(list[0]?.description, "Heat the oven first.");
  assert.match(skillCatalog(list), /bake: Heat the oven first/);
  assert.match(readSkill(root, "bake").text, /Step one/);
  assert.throws(() => readSkill(root, "../bake"));
  writeSkill(root, "stew", "---\ndescription: Simmer.\n---\n# Stew\n");
  assert.equal(listSkills(root).find((s) => s.name === "stew")?.description, "Simmer.");
  assert.throws(() => writeSkill(root, "../stew", "nope"));
  writeSkillFile(root, "stew", "scripts/simmer.js", "export const minutes = 40;\n");
  editSkillFile(root, "stew", "SKILL.md", "# Stew", "# Stew\n\nSee scripts/simmer.js");
  assert.deepEqual(listSkillFiles(root, "stew").files, ["SKILL.md", "scripts/simmer.js"]);
  assert.match(readSkillFile(root, "stew", "scripts/simmer.js").text, /minutes = 40/);
  assert.throws(() => writeSkillFile(root, "stew", "../secret.txt", "nope"));
});
