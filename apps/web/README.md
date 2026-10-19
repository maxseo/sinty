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
