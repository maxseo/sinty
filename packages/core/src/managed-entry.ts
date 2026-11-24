import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Sinty } from './sinty.js';
import { startServer } from './api/server.js';
declare const __SINTY_MANAGED_TEST_HEALTH_FAIL__: boolean;
declare const __SINTY_MANAGED_BUILD_VERSION__: string;
declare const __SINTY_MANAGED_TEST_ORIGIN__: string;
export async function startManaged({ home, gate, runtime }: {
    home: string;
    gate: {
        readonly blocked: boolean;
        enter(): () => void;
    };
    runtime: {
        root: string;
        version: string;
        sha256: string;
        instance: string;
    };
}) { const install = dirname(fileURLToPath(import.meta.url)); process.env.SINTY_INSTALL_ROOT = install; const applicationVersion = typeof __SINTY_MANAGED_BUILD_VERSION__ !== "undefined" ? __SINTY_MANAGED_BUILD_VERSION__ : JSON.parse(readFileSync(join(install, "release.json"), "utf8")).version; const buildHash = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"); if (applicationVersion !== runtime.version)
    throw Error("application_version_mismatch"); const release = JSON.parse(readFileSync(join(install, "..", "release.json"), "utf8")); if (release.appBuildHash && release.appBuildHash !== buildHash)
    throw Error("application_build_mismatch"); const s = new Sinty({ home, managed: { ...runtime, gate, applicationVersion, buildHash, ...(typeof __SINTY_MANAGED_TEST_ORIGIN__ !== "undefined" && __SINTY_MANAGED_TEST_ORIGIN__ ? { testFeedOrigin: __SINTY_MANAGED_TEST_ORIGIN__ } : {}) } }); const result = await s.start(); if (result.failedPlugins.length) {
    await s.stop();
    throw Error('managed_plugins_not_ready');
} const { server, url } = await startServer(s, { ...(typeof __SINTY_MANAGED_TEST_ORIGIN__ !== "undefined" && __SINTY_MANAGED_TEST_ORIGIN__ ? { testing: { catalogLoopbackOrigin: __SINTY_MANAGED_TEST_ORIGIN__ } } : {}) }); writeFileSync(join(runtime.root, 'control', 'runtime-endpoint.json'), JSON.stringify({ url, version: runtime.version, sha256: runtime.sha256 }), { mode: 0o600 }); let stopped = false; return { health: async () => !stopped && !s.pluginRecoveryIssue && !(typeof __SINTY_MANAGED_TEST_HEALTH_FAIL__ !== "undefined" && __SINTY_MANAGED_TEST_HEALTH_FAIL__), drain: async () => { await s.pauseManaged(); const until = Date.now() + 5000; while (s.managedBusy) {
        if (Date.now() > until)
            throw Error('managed_instance_busy');
        await new Promise(r => setTimeout(r, 20));
    } }, resume:async()=>{await s.resumeManaged()}, stop: async () => { if (stopped)
        return; stopped = true; (server as unknown as {
        closeAllConnections?: () => void;
    }).closeAllConnections?.(); await new Promise<void>(r => server.close(() => r())); const ps = [...s.host.plugins.values()]; await s.supervisor?.stopAndWait(); await s.stop(); await Promise.all(ps.map(p => p.stopAndWait())); } }; }
