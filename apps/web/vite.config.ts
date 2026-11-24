import { readFileSync } from "node:fs";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const release = JSON.parse(readFileSync(new URL("../../release.json", import.meta.url), "utf8")) as { version: string };

const api = process.env.SINTY_URL ?? "http://127.0.0.1:3180";

export default defineConfig({
  plugins: [preact(), { name: "sinty-release-version", transformIndexHtml: (html) => html.replace("<title>Sinty</title>", `<title>Sinty ${release.version}</title><meta name="sinty-version" content="${release.version}">`) }],
  base: "./",
  build: {
    outDir: "../../plugins/ui-web/public",
    emptyOutDir: true,
    target: "es2023",
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: { "/v1": api, "/p": api },
  },
});
