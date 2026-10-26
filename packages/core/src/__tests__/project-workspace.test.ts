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

test("chat attachments in a project session are copied into projects/<slug>/_inbox", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ text: "got it" }], { policy: allowAll, plugins: ["fake-provider"] });
  try {
    const { saveBlob } = await import("../blobs.js");
    const project = saveProject(sinty.paths, { name: "Inbox Demo" });
    const session = sinty.agent.createSession({ projectId: project.id });
    const note = saveBlob(sinty.paths.data, { bytes: Buffer.from("hello-inbox"), mime: "text/plain", name: "note.txt" });
    sinty.agent.send(session.id, "please read the file", { attachments: [note] });
    await sinty.agent.idle();
    const inboxFile = join(projectDir(sinty.paths, project), "_inbox", "note.txt");
    assert.equal(existsSync(inboxFile), true, `expected ${inboxFile}`);
    assert.equal(readFileSync(inboxFile, "utf8"), "hello-inbox");
  } finally {
    await sinty.stop();
    cleanup();
  }
});

test("chat attachments without a project do not create a stray _inbox under workspace", async () => {
  const { home, cleanup } = tempHome();
  const sinty = await boot(home, [{ text: "ok" }], { policy: allowAll, plugins: ["fake-provider"] });
  try {
    const { saveBlob } = await import("../blobs.js");
    const session = sinty.agent.createSession();
    const note = saveBlob(sinty.paths.data, { bytes: Buffer.from("no-project"), mime: "text/plain", name: "loose.txt" });
    sinty.agent.send(session.id, "file", { attachments: [note] });
    await sinty.agent.idle();
    assert.equal(existsSync(join(sinty.paths.workspace, "_inbox", "loose.txt")), false);
  } finally {
    await sinty.stop();
    cleanup();
  }
});