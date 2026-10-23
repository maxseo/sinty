import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { policySchema } from "../config.js";
import { projectDir, saveProject } from "../roster.js";
import { boot, tempHome } from "./helpers.js";

const allowAll = policySchema.parse({ defaults: { none: "allow", read: "allow", write: "allow", external: "allow" } });

test("fs.write in a project session lands under projects/<slug>/_out, not the global _out", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "fs__write", args: { path: "_out/from-project.txt", content: "project-chroot" } }] },
      { text: "done" },
    ],
    { policy: allowAll, plugins: ["fake-provider", "tool-fs"] },
  );
  try {
    const project = saveProject(sinty.paths, { name: "Chroot Demo" });
    const session = sinty.agent.createSession({ projectId: project.id });
    sinty.agent.send(session.id, "write a file");
    await sinty.agent.idle();
    const folder = projectDir(sinty.paths, project);
    const inProject = join(folder, "_out", "from-project.txt");
    const inGlobal = join(sinty.paths.workspace, "_out", "from-project.txt");
    assert.equal(existsSync(inProject), true, `expected ${inProject}`);
    assert.equal(readFileSync(inProject, "utf8"), "project-chroot");
    assert.equal(existsSync(inGlobal), false, "must not write to the global workspace _out");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("fs.write without a project still uses the global workspace", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(
    home,
    [
      { toolCalls: [{ name: "fs__write", args: { path: "_out/from-global.txt", content: "global-ws" } }] },
      { text: "done" },
    ],
    { policy: allowAll, plugins: ["fake-provider", "tool-fs"] },
  );
  try {
    const session = sinty.agent.createSession();
    sinty.agent.send(session.id, "write a file");
    await sinty.agent.idle();
    const inGlobal = join(sinty.paths.workspace, "_out", "from-global.txt");
    assert.equal(existsSync(inGlobal), true);
    assert.equal(readFileSync(inGlobal, "utf8"), "global-ws");
  } finally {
    await sinty.stop();
    cleanup();
  }
});
