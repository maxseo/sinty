# tool-vision: look at workspace images

- Date: 2026-10-26
- Area: `plugins/tool-vision`, `skills/vision-look`, `DEFAULT_ON_PLUGINS`, registry
- Plan step: harness — vision for repo images (chat attachments already work via blobs → image_url)
- Commits: this commit
- PR: (open)

## What and why

Chat attachments become `ChatMessage.images` and openai-compat providers send `image_url` data URLs.
Files that only live in the workspace are still opened with `fs.read` (UTF-8), so the agent "sees" bytes, not pixels.
Tool results are text-only, so the fix is a **side** `ctx.models.complete` call that returns a description — same pattern as fact-extractor, packaged as a tool plugin like tool-web.

## Files touched

- `plugins/tool-vision/*` — `vision.look`, settings, path/mime helpers, tests, README
- `skills/vision-look/SKILL.md` — when to use the tool vs `fs.read`, mode prompt tips
- `packages/core/src/config.ts` — `tool-vision` in `DEFAULT_ON_PLUGINS`
- `registry/plugins.json`, `CHANGELOG.md`, this journal entry

## Design decisions

- **Plugin-only (plugins-over-core).** No change to the main turn pipeline; pixels never re-enter the parent prompt mid-flight.
- **Default-on** like tool-web: looking at project screenshots is a baseline harness ability; policy **ask** still gates the paid call.
- **Route: `vision` → `default`.** Settings `modelRoute` overrides. Document that the route must be openai-compat for images (Anthropic/Responses ignore `images` today).
- **8 MB cap** matching `packages/core/src/blobs.ts` `MAX_BYTES`.
- **Skill separate** (install via `sinty skills add`), same as `mcp-install` — not baked into the prompt until installed.

## Rejected alternatives

- Folding pixels into the main agent turn after a tool call (architecture: tool results are text).
- A separate local OCR engine (vision models cover describe + OCR for now).
- Putting vision into core / tool-fs (keep fs text-only; vision is a model side call).

## Migration notes

- Existing installs pick up `tool-vision` via `withDefaultPlugins` unless listed in `plugins.disabled`.
- Set `models.routes.vision` to an openai-compat vision model when it should differ from `models.default` (Settings → Models named-routes UI is a separate PR).
- Skill: `sinty skills add ./skills/vision-look` (or Settings → Skills → Добавить).

## Known limitations

- No true "speaker model" binding — plugin API only sees named routes / default, not the roster model of the speaking agent.
- Anthropic / OpenAI Responses providers ignore `images` on this side call until they map them.
- SVG excluded (`image/svg+xml`) — treat as text via `fs.read`.
- Does not backfill or rewrite past chats.

## How to test

```bash
pnpm --filter @sinty/plugin-tool-vision test
```

Manual: enable plugin → put a PNG under the project → `vision.look` with `mode: ocr` → approve ask → read `text` in the tool result.
