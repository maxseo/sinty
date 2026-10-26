# Settings → Лимиты and a higher plugin day budget

«Тест 8» stopped `vision.look` with `models_budget`: plugin `tool-vision` had used 207112 tokens against `models.pluginTokensPerDay` 200000 (the code default; the key was absent in config.yaml). The counter is per plugin per UTC day and does not reset until 00:00 UTC.

## What changed

- The default is 2_000_000. `0` is still unlimited. The local config.yaml now sets `models.pluginTokensPerDay: 2000000`, so today's counter (207112) is under the cap after restart.
- Settings → **Лимиты** (`id: limits`) edits four keys and applies them on the live config: `models.pluginTokensPerDay`, `models.maxOutputTokens` (8192), `agent.taskMaxParallel` (3), `agent.taskTreeTokens` (0 = no shared tree cap).
- The per-turn budget (steps, tokens, seconds, stop) stays in Settings → Супервизор. Compaction cap stays in Память и контекст. Policy `budgets.turn` in policy.yaml is still the fallback when the supervisor budget fields are empty (steps 60, tokens 600000, seconds 1200).

## Revert

Delete the `limits` section in `packages/core/src/settings-sections.ts` and the `id === "limits"` branch in `packages/core/src/api/server.ts`. Put `DEFAULT_PLUGIN_TOKENS_PER_DAY` back to `200_000` in `packages/core/src/models.ts`.
