# tool-vision

Workspace images for the agent: **`vision.look`** reads a PNG/JPEG/… under the session workspace
(project chroot when set) as binary, sends it through `ctx.models.complete` with `ChatMessage.images`,
and returns **text** (tool results cannot carry pixels back into the main turn).

Chat attachments already become `image_url` on openai-compat providers. Files sitting in the repo do not —
`fs.read` is UTF-8 text. This plugin closes that gap without putting vision into core.

## Tool

| Name | Policy | What it does |
|------|--------|----------------|
| `vision.look` | ask (`external`) | `path` or `paths` + optional `mode` (`describe` \| `ocr` \| `find`) + optional `prompt` |

## Model route

1. `plugins.config.tool-vision.modelRoute` if set (Settings → Vision), else
2. `models.routes.vision`, else
3. `models.default`

The provider for that route must be **openai-compat** (or another protocol that maps `images` to
`image_url` data URLs). **Anthropic** and **OpenAI Responses** plugins currently ignore `images` on
side calls — descriptions will be empty or useless until those providers grow vision support.

## Settings / config keys

| Key | Default | Notes |
|-----|---------|--------|
| `modelRoute` | `""` | Named route or `provider/model` |
| `maxImageMb` | `8` | Hard cap (same as chat blobs) |
| `reasoning` | `false` | When off, a DeepSeek call disables thinking. The side call does not send `max_tokens`. |
| `batch` | `4` | Max images per model request (1–16). A longer `paths` list is split into further requests with the same prompt. |

## Skill

Install the companion skill so the agent knows when to call the tool:

```bash
sinty skills add ./skills/vision-look
```

## Permissions

- `fs.read`: `$WORKSPACE`, `$SKILLS`
- `models`: `vision`, `default`, `*` (override may be any route / provider/model)
