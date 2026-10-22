# Embedding and decision routes in settings

- Date: 2026-10-22
- Area: packages/core, apps/web
- Plan step: backlog, embeddings and model routes
- Commits: this commit

## What and why
Vector recall stays off until `models.routes.embed` is set, and that key was only editable in `config.yaml`. Settings → Модели now stores it, plus `memory.dimensions`, and a `models.routes.decision` route for later side decisions. A message sent while a turn is running was already appended to that turn; the composer now says so, and «Прервать» in the general settings stops the turn first.

## Files touched
`packages/core/src/config.ts` (`saveSettings`), `packages/core/src/api/server.ts` (`GET`/`PUT /v1/settings`), `packages/core/src/models.ts` (`resolve("decision")`), `apps/web/src/pages.tsx`, `apps/web/src/chat.tsx`, `docs/spec/memory.md`.

## Design decisions
`decision` resolves like `embed`: only the saved route, no fallback. The turn loop does not call it. Empty strings delete the route keys. The live process copies `models.routes` and `memory.dimensions` after save; the open sqlite-vec table keeps its old width until restart and `sinty memory reembed`.

## Rejected alternatives
A separate settings section. The model page already owns routes.

## Migration notes
Existing configs without the keys stay on full-text recall. No database migration.

## Known limitations
`decision` is unused. `sinty doctor` still does not print "vector recall: off". A turn blocked on approval still returns `409 turn_active`.

## How to test
`node --test packages/core/src/__tests__/models.test.ts` covers `resolve("decision")` and `saveSettings` round-trip. In the UI, pick an enabled route, save, and confirm `config.yaml` `models.routes.embed` and `models.routes.decision`.
