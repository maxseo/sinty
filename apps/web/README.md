# Web UI

Preact + Vite app. `pnpm build` writes the bundle to `plugins/ui-web/public`, which the core serves at `/ui/ui-web/`.

Talks only to the public HTTP API ([protocol](../../docs/spec/protocol.md)). The token is a bearer header; EventSource cannot send headers, so live streams use `fetch` + SSE.

| Page | Source |
|---|---|
| Chat, streaming, tool cards, approvals, resume | `src/chat.tsx` |
| Session list and live badges | `src/app.tsx` via `GET /v1/stream` |
| Kanban | `src/board.tsx` via `/p/kanban` |
| Pending, supervisor, plugins | `src/pages.tsx` |

`vite` in `dev` proxies `/v1` and `/p` to `SINTY_URL` (default `http://127.0.0.1:3180`).

## Isolated UI regressions

After the normal workspace install, run from the repository root:

```sh
node --test --test-concurrency=1 apps/web/tests/ui.test.mjs
```

The suite uses the workspace Playwright dependency from `plugins/tool-web` and its installed Chromium. It starts its own Vite fixture server on an ephemeral loopback port, mocks every API request and uses a clean headless browser context. It never connects to the running Sinty server or its accounts. It covers actual agent model selects in clipped/transformed accordions, viewport/scroll behavior, Skills API wiring and all 46 approved UI Kit specimens in both themes. Test screenshots are written to `.git/agent-backups/select-skills-kit-20261110/screenshots`.
