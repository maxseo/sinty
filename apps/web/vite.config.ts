import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const api = process.env.SINTY_URL ?? "http://127.0.0.1:3180";

export default defineConfig({
  plugins: [preact()],
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
