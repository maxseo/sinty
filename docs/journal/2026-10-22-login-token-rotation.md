# Login token rotation

- Date: 2026-10-22
- Area: `packages/core` (secrets, HTTP API), `packages/cli`, `apps/web`
- Plan step: queue after step 7 ([plan](../plan.md) section 5: login token rotation)
- Commits: `14fb68b feat(auth): login token rotation (CLI, Settings, POST /v1/auth/rotate)`
- PR: [#15](https://github.com/maxseo/sinty/pull/15) (merge `674376e`)

## What and why

The login token for the HTTP API and the Web UI is the secret `api.token` (`snt_` + 24 random bytes, base64url),
created by `initHome` and referenced as `server.token: secret://api.token`. There was no way to replace it after a
link with `#token=` leaked: `sinty secret set api.token …` changed the file, but a running server neither accepted
the new value nor rejected the old one, and its next secret write restored the old value. The Web UI sign-in screen
also pointed to `sinty token`, which did not exist.

Now:

- `rotateApiToken(secrets, config)` (`packages/core/src/api-token.ts`) stores a new random token under the secret
  `server.token` points at and returns it. `newApiToken()` is shared with `initHome`.
- `POST /v1/auth/rotate` (needs the current token) answers `{ token }` with `cache-control: no-store`.
- `sinty token` prints the current token; `sinty token rotate` rotates it and prints the new one only with `--print`
  (so a terminal log or screen share does not show it by default).
- Settings → Основные → «Сменить токен входа»: confirm, rotate, keep the new token in this tab's `localStorage`, then
  offer «Скопировать ссылку входа» (clipboard; the token is never rendered on the page).

The old token stops working at once everywhere: `createApp` resolves the token on every request instead of once at
start, and `SecretStore` re-reads `secrets.json` when its mtime, size or inode changed (checked in `get`, `names`,
`redact` and before `set`/`delete` write). Open core SSE streams remember the token they were opened with; they
re-check it on every 15 s ping and immediately after `POST /v1/auth/rotate`, and on a mismatch send
`event: auth.revoked` and end. The Web UI ignores that event; its reconnect then gets `401` and shows the sign-in
screen (or, in the tab that rotated, reconnects with the new token).

## Files touched

- `packages/core/src/api-token.ts` (new): `newApiToken`, `apiTokenSecretName`, `rotateApiToken`,
  `TokenRotationError`; exported from `index.ts`.
- `packages/core/src/secrets.ts`: `refresh()`/`load()` and a file stamp.
- `packages/core/src/sinty.ts`: `initHome` uses `newApiToken`.
- `packages/core/src/api/server.ts`: per-request token check, `POST /v1/auth/rotate`, `sse()` with a stream guard.
- `packages/cli/src/bin.ts`, `packages/cli/README.md`: `sinty token [rotate [--print]]`.
- `apps/web/src/api.ts` (`rotateToken`, `auth.revoked` filtered), `apps/web/src/pages.tsx` (`TokenRow`).
- `packages/core/src/__tests__/token-rotation.test.ts` (new, 4 tests); `docs/spec/protocol.md`; `CHANGELOG.md`.

## Design decisions

- Core, not a plugin: authentication of the core API and the secret store are core concerns; there is no plugin
  hook for them and adding one for this would widen the trusted surface. The change adds no prompt content, so the
  cache-friendly prompt is unaffected.
- Rotation refuses (`409 token_literal` / `token_env`) when `server.token` is a literal string in `config.yaml` or
  `SINTY_SECRET_API_TOKEN` is set: writing a new secret would not change the effective token there, and silently
  editing `config.yaml` is out of bounds.
- The response of `POST /v1/auth/rotate` carries the new token because the caller already holds the old one, which
  grants the same power; otherwise the rotating tab would lock itself out.
- `sinty token rotate` hides the token unless `--print`.
- The old token is no longer in `SecretStore.redact` after a rotation; it is dead, so a later leak of it is harmless.

## Rejected alternatives

- A token epoch kept in memory: it would not see a rotation by the CLI process next to the server.
- Watching `secrets.json` with `fs.watch`: unreliable on network drives and Windows; a `statSync` per read is cheap.
- Closing streams by tearing down all connections: also kills streams that already use the new token.

## Migration notes

None: the secret name and format are unchanged. Every client that stored the old token (other browsers, scripts,
MCP clients, Herdr) needs the new one after a rotation.

## Known limitations

- Long-lived streams served by plugins under `/p/:plugin/*` are authorized once at start and are not cut on
  rotation; their next reconnect gets `401`.
- A rotation by another process reaches open core streams on their next ping (up to 15 s), not instantly.
- Two processes writing secrets at the same moment can still lose one write (last writer wins); before, the server
  overwrote any outside change on every write.
- Windows not tested (the box run is Linux only); `statSync` with `bigint` works there, but the file stamp has not
  been checked on NTFS.
  Update (2026-10-22): the full test suite, including this change's tests, passed on Windows on main `277db15`
  (Node 24.12.0); a rotation by hand on Windows is not recorded.

## How to test

- `node --test packages/core/dist/__tests__/token-rotation.test.js`: rotate via the API (old → 401, new → 200,
  `no-store`), SSE ends with `auth.revoked`, rotation from a second `SecretStore` (the CLI) applies to the running
  app and is not overwritten by the server's next write (this test fails on the old `secrets.ts`: "old token
  rejected without a restart"), refusal for a literal token and an env override.
- By hand: `sinty web`, open the link, Settings → Основные → «Сменить токен входа»; a second tab with the old token
  shows the sign-in screen; `sinty token rotate` while the server runs, then the open tab goes to sign-in.
