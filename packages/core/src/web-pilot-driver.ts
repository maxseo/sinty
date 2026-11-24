import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserPilotError, type BrowserPilotDriver, type BrowserNativeTool } from "./browser-pilot.js";
import { startGuardProxy, checkPublicUrl } from "./netguard.js";

/** Lazy bridge into the Browser plugin using the existing Playwright backend. Constructing Sinty never launches a browser. */
export function createWebToolsPilotDriver(data: string): BrowserPilotDriver {
  const modulePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins/tool-browser/dist/persistent.js");
  // Lazy canonical Browser module; no browser starts at construction.
  let loaded: Promise<BrowserPilotDriver> | undefined;
  const load = (): Promise<BrowserPilotDriver> => loaded ??= import(pathToFileURL(modulePath).href).then((module) => new module.WebToolsPilotDriver({
    profiles: join(data, "web-browser-profiles"), headless: false,
    checkPublicUrl: async (url: string) => { await checkPublicUrl(url); },
    proxy: (origin: string) => {
      if (!origin) return startGuardProxy(() => ({}));
      const u = new URL(origin);
      if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port || u.origin !== origin || u.username || u.password) throw new BrowserPilotError("fixture_only", "Only the owner-controlled fixture origin is allowed");
      return startGuardProxy(() => ({ allow: [{ host: "127.0.0.1", port: Number(u.port) }] }));
    },
  }) as BrowserPilotDriver);
  const guarded = async <T>(work: Promise<T>): Promise<T> => { try { return await work; } catch (error) { const e = error as { code?: unknown; message?: unknown }; throw new BrowserPilotError(typeof e.code === "string" && /^[a-z_]{1,64}$/.test(e.code) ? e.code : "web_browser_failed", String(e.message ?? "Owned browser operation failed").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1000)); } };
  return {
    prepare: (args, signal) => guarded(load().then(driver => driver.prepare(args, signal))),
    call: (tool: BrowserNativeTool, args, signal) => guarded(load().then(driver => driver.call(tool, args, signal))),
    close: async session => loaded ? (await loaded).close(session) : true,
  };
}
