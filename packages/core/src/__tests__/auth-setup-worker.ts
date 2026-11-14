import { parentPort, workerData } from "node:worker_threads";
import { AccountError, Accounts } from "../accounts.js";

const { file, email } = workerData as { file: string; email: string };
function open(): Accounts {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try { return new Accounts(file); } catch (e) {
      last = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
  throw last;
}
const a = open();
try {
  const r = a.setup({ email, password: "secret-pass" });
  parentPort!.postMessage({ ok: true, id: r.user.id, system: r.user.system, hasToken: Boolean(r.token) });
} catch (e) {
  const code = e instanceof AccountError ? e.code : "other";
  parentPort!.postMessage({ ok: false, code });
} finally {
  a.close();
}
