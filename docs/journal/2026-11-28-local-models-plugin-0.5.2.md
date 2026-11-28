# 2026-11-28 ? Port local-models plugin onto Sinty 0.5.2

- Date: 2026-11-28
- Area: plugins/local-models, packages/core (bindings/upload), apps/web Settings → Models
- Commits: this commit (import fix and journal); cherry-pick of c5f5c98 onto release/0.5.2
- Related: open PR #94 is the same feature against release/0.5.1-local and is now stale relative to 0.5.2

## What and why

The agreed v1 plugin «Локальные модели» already existed as PR #94 on 0.5.1-local. The current intended clean tree is release/0.5.2 (`c7f9d00`). This port cherry-picks that work and adapts the three conflicts so later 0.5.2 UI placements (`plugins`, `agent`) are kept, while `ui.tabs.group: "models"` still hosts the subtab.

A silent auto-merge left a duplicate `PluginTab` import in `apps/web/src/pages.tsx` (0.5.2 already imported it). That is fixed here so web `tsc` passes.

## Files touched

- `apps/web/src/pages.tsx` (deduped import)
- this journal and `docs/journal/README.md` index rows
- the rest of the plugin and core bridges landed in the cherry-pick commit

## Design decisions

- New PR against `release/0.5.2`, not a force-push of `feat/local-models-plugin` or a rewrite of tags `v0.5.1` / `v0.5.2`.
- Keep plugin off by default; no autostart of llama-server on enable/load.
- Bind catalog routes by a stable id, not an ephemeral port.

## Known limitations

Unchanged from v1: no multiple concurrent servers, no Hugging Face download, no auto-install of llama.cpp, no autostart, no client-PC connector from a cloud Sinty window, no automatic tool-calling/vision enablement.

## How to test

In an isolated checkout (not the live Sinty 0.5.1 process):

1. `pnpm install` and build packages/plugins as usual.
2. Core: local-models-api, model-bindings, plugin-upload, and context-inspect tab-group tests.
3. Plugin tests with `SINTY_LOCAL_MODELS_TEST=1`.
4. To try the UI later: enable `local-models` in Settings, open Settings → Модели → Локальные модели, point at an existing `llama-server` binary, import or register a GGUF, Start, then bind to the catalog.
