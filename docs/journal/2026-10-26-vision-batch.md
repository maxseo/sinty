# vision.look batches

Ninety similar scans were one `vision.look` each. The provider already puts every `ChatMessage.images` entry on one user message, so several files can share one prompt.

## What changed

- `vision.look` takes `path` or `paths` (up to 200). One tool call loads them all and sends them in chunks of `plugins.config.tool-vision.batch`.
- Settings → Vision field **Batch**, default 4, clamped 1–16. The same `prompt` and `mode` apply to every chunk. The prompt lists paths in order and asks for a separate answer headed by each path.
- A single `path` still returns `path`, `mime`, `bytes`, and `text`. A batch also returns `images`, `batches`, `count`, and `batchSize`.
- Tool timeout is 15 minutes so a long list can finish inside one call.

## Still true

A chunk larger than 4 is allowed only by raising Batch. Ninety images in one model request is not the default: pages get mixed and the request body gets large. Anthropic and Responses side calls still ignore images.
