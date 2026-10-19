# Memory step 5: memory-obsidian, fact-extractor, working vector search

- Date: 2026-10-19
- Area: plugins/memory-obsidian, plugins/fact-extractor, packages/core (sinty.ts, memory-router.ts, host/manifest.ts)
- Plan step: memory plan, step 5
- Commits: `feat: memory step 5…`

## What and why

1. **Vector search in the builtin store actually works.** sqlite-vec tables existed since M5 but nothing produced
   embeddings, so recall was FTS-only. When `models.routes.embed` is set, `Sinty` gives the router an embedder backed by
   `ModelGateway.embed()`; the router embeds the text of every builtin write and the query of every builtin recall
   (tool and automatic) and the store fuses FTS5 and vec0 by RRF. A width that differs from `memory.dimensions`, or any
   embed error, journals one `memory.degraded` per process and falls back to FTS. Without an embed route nothing changes.
2. **`plugins/memory-obsidian`** (disabled by default) — read-only provider over a Markdown/Obsidian vault:
   heading-level chunks, BM25 with title/heading boost, own index in `$DATA/index.json` refreshed by mtime at most every
   `rescanSeconds`, skips dot-folders/`.obsidian`/`.trash`, size and file-count caps. Records carry `ref` = vault path and
   reach the prompt as untrusted external memory.
3. **`$CONFIG.<key>` read grants.** The vault is outside every existing grant root. The manifest says
   `"read": ["$CONFIG.vault"]`, which expands only to the absolute path the human put in `config.yaml`
   (`plugins.config.memory-obsidian.vault`). Manifest defaults are ignored (the agent can patch manifests), relative or
   unset values drop the grant, and `$CONFIG` is rejected in write grants.
4. **`plugins/fact-extractor`** (disabled by default) — processor:
   - `afterTurn`: asks `ctx.models.complete({ route: "cheap" })` for up to `maxFacts` durable facts as JSON and returns
     them; the core writes them (`source: fact-extractor`, journaled), accounts usage in the session and the plugin budget.
   - `onWrite`: drops credential-looking text (API key prefixes, AWS keys, private keys, `password: …`, long hex/base64),
     drops short fragments not written by the agent itself, normalises whitespace, caps length.

## Files touched

`plugins/memory-obsidian/**`, `plugins/fact-extractor/**` (new), `registry/plugins.json`, `pnpm-lock.yaml`,
`packages/core/src/sinty.ts` (embedder), `packages/core/src/host/manifest.ts` + `host/host.ts` (`$CONFIG` grants),
`docs/spec/plugin-manifest.md`, tests `memory-plugins.test.ts`, fixture `recording-provider` (toy `embed`).

## Design decisions

- Obsidian search is lexical first: it works without any model and without network, and keeps the plugin read-only.
  Embeddings for the vault can come later through `ctx.models.embed` (the plumbing exists).
- The extractor returns facts instead of writing: every fact passes `onWrite` (its own secret filter included) and is
  journaled with its origin.
- `order: 50` for fact-extractor so its secret filter runs before other processors' `onWrite`.

## Rejected alternatives

- Letting the obsidian plugin read `$WORKSPACE` and asking users to symlink the vault: confusing and widens access.
- A generic "allow any path from config" grant: `$CONFIG` is restricted to read and to human-owned config.
- Extracting facts in `beforeContext` (synchronously): adds model latency to every step.

## Migration notes

- To use vectors on an existing install: set `models.routes.embed` to a model whose width equals `memory.dimensions`
  (1536 for `text-embedding-3-small`). Old facts have no vectors and are still found by FTS; re-writing a fact adds one.
- `memory.dimensions` is fixed for the life of `memory.db` (vec0 table width).

## Known limitations

- No backfill command for vectors of old facts yet.
- memory-obsidian: no embeddings, no attachments/Dataview, index is a single JSON file (fine for thousands of notes,
  not for hundreds of thousands).
- fact-extractor quality depends on the cheap model; there is no deduplication beyond the builtin store's sentence hash.

## How to test

`node --test dist/__tests__/memory-plugins.test.js`: vector hit with no lexical overlap, wrong width → one
`memory.degraded`, vault recall (untrusted block, own index, dot-folders skipped), extraction via `cheap` + secret drop,
`$CONFIG` grant rules.
