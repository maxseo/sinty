# Native agent model profiles

Agents → Models has a gear beside the selected main model. Profiles belong to that agent and to the exact resolved provider/model route (including any further slashes in the model ID). Switching the selected route never copies a profile. Fallbacks look up their own profiles. The editor changes the card draft; save the agent card to persist it.

## Persistence and compatibility

The optional AgentRecord.modelProfiles map is stored in data/roster.json by the existing roster API. Old records need no migration. Omitted modelProfiles in an update preserves the previous map; an empty map explicitly resets it. Invalid optional profiles loaded from manually damaged data are ignored without hiding agents/personas. API writes reject invalid maps before modifying the roster.

An empty output field inherits the CURRENT models.maxOutputTokens at request time, not a snapshot of its value when the profile was saved. A custom limit is a positive safe integer and is not clamped to the global value. Reset removes the override. This is an output limit, not the server context size. One resolved limit per route is passed both to the model and to the existing fallback-window reservation; editing a card while a request is being built cannot mix two profile snapshots. Existing compaction thresholds/policies are unchanged.

No profile (or an empty profile) preserves the previous payload exactly. Configured provider options remain the defaults for sampling/cache/reasoning. Explicit profile values override them without mutating provider configuration. In an active native Anthropic profile, max_tokens is synchronized with the inherited/custom output limit because its adapter otherwise lets raw provider options override the request limit. Existing unprofiled behavior is preserved.

Profiles apply ONLY to the agent main-turn/fallback path. They are not inherited by compaction/service calls, ctx.models.complete, embeddings, transcription or a different agent, even if the route is identical. No SDK or IPC change is needed: validated options use the existing ProviderEndpoint.options transport. Dynamic Tools preserves that transport; its own OFF/ON selection changes tools, not generation parameters.

## Explicit advanced mode, not inferred model capabilities

The catalog does not report verified parameter support. The read-only generation metadata on GET /v1/models describes adapter/protocol implementations, NOT individual model capabilities; modelSupport is unknown. Manual advanced fields require explicit acknowledgement and may still be rejected or ignored by an upstream model. There is no automatic probing, provider retry, or unsupported-parameter stripping.

* openai-compat: temperature (0–2), top_p (>0–1), top_k (positive integer), frequency/presence penalties (−2–2), and backend-specific repeat_penalty OR repetition_penalty (>0–100). Choose only the actual spelling your backend supports.
* anthropic: temperature (0–1), top_p, top_k; explicit thinking budget ≥1024 and below the effective output limit. Explicit thinking is not combined with manual sampling (including configured provider sampling); inherited thinking budgets must fit a custom output limit. Adaptive-thinking-only models are not covered by that legacy budget control; leave it inherited.
* openai-responses: temperature, top_p, and low/medium/high reasoning effort.
* openai-compat reasoning effort uses low/medium/high. Off is exposed only for the existing direct api.deepseek.com thinking-disabled implementation, NOT for RunningHub/OpenRouter/local proxies or other providers.
* anthropic cache controls concern cache breakpoints and 5m/1h TTL (1h can cost more on writes).
* openai-compat/Responses prompt-cache key control only controls sending the session routing key. False does NOT disable automatic remote caching.

Unset sampling fields send no agent override (configured provider defaults still apply); zero temperature is preserved. Nonfinite numbers, unsafe/fractional output limits, unknown fields, arbitrary body/endpoint overrides and unsupported protocol controls are rejected. Protocol-level checks are conservative; model-specific parameter combinations still require the user's API documentation. No GPU/KV/parallel/server-launch/n_ctx controls are exposed.

## Rollback

This feature is isolated in its own PR. Reverting its commit removes the feature without touching the installed app automatically; use the ordinary reviewed installation procedure for deployment. Existing roster records remain readable by the prior version (unknown profile fields are ignored), but saving an agent with that older version drops its profiles. Before rollback, export/back up the latest roster if retaining those profiles matters; do not blindly restore an old full roster over newer user edits. Source backup is separate from live data. No installation/configuration/roster writes are required to build or test this PR.

## Offline checks

Core: pnpm --filter @sinty/core build && node --test packages/core/dist/__tests__/model-profile.test.js

Web: pnpm --filter @sinty/web build && node --test apps/web/tests/model-settings.test.mjs

The new tests use fake API state, temporary rosters, mocked model fetch and headless fixture pages; no paid calls or installed application processes are involved.
