---
name: rhany-run
description: Call RunningHub via rhany.run / runninghub.run with reference images. Use before Seedream or Dola image-to-image when refs, imageUrls, or dola-Seedream endpoints are involved.
---

# RunningHub refs (rhany + runninghub)

## Canonical successful call (rhany)

This is the shape that last produced a picture. Prefer it for `dola-Seedream-5.0-pro/image-to-image` and other endpoints missing from the public registry.

```json
{
  "endpoint": "dola-Seedream-5.0-pro/image-to-image",
  "payload": {
    "prompt": "<user prompt>",
    "width": 1280,
    "height": 1920,
    "resolution": "1k",
    "outputFormat": "jpeg",
    "imageUrls": [
      "https://www.runninghub.cn/view?..."
    ]
  },
  "timeoutSeconds": 400
}
```

Rules from that run:

- **Endpoint** is only the model path: `dola-Seedream-5.0-pro/image-to-image`. No `https://www.runninghub.ai/openapi/v2/` prefix, no invented `-nsfw` suffix.
- **Reference is a URL** in `payload.imageUrls` (array). Reuse a RunningHub `view` / download URL when you already have one. Do not pass project `_inbox` paths in `files` for `rhany.run`.
- **`resolution`** must be `"1k"` or `"2k"`. Never omit it and never send `"empty"` / `""` - the model rejects that.
- After success, take **`urls[0]`** from the tool result and immediately **`web.fetch_file`** it into the project (for example `_out/generation/<taskId>/0.jpg`). Result links live about a day. Object storage hosts (`ark-acg-...volces.com` and friends) often fail inside the plugin save step - `web.fetch_file` is the reliable pull.

## Pick the tool

1. If the model is in the RunningHub registry: `runninghub.search` -> `runninghub.schema` -> **`runninghub.run`**. That plugin can read the chat project, so local refs are `files: [{ "field": "imageUrls", "path": "./_inbox/<name>" }]`.
2. If the model is **not** in the registry (custom Dola path the user pasted): **`rhany.run`** with the raw path, as in the canonical call above.

## rhany local files (limited)

`rhany` is an agent-made plugin. `fs.read` is only `$DATA` and `$PLUGIN`. It cannot open the chat project.

- `files: [{ "field": "imageUrls", "path": "..." }]` - only a file that already lives under `$DATA` (or the plugin folder). Do not use `_inbox/...`, `./_inbox/...`, bare names, or absolute Windows paths.
- Do not `shell.run` copy into `~/.sinty/data` (blocked as secrets).
- If the ref is only in `_inbox` and you have no URL yet: either (a) use **`runninghub.run`** when a registry model is acceptable, or (b) pass **`blobs`** `{ field, name, base64 }` (encode with a short `shell.run` Python one-liner; keep images small). Prefer a real HTTPS URL in `payload.imageUrls` when you have one - that is what worked.

Several refs: same field repeated, order = `@image1`, `@image2`, `@image3`:

```json
"imageUrls": ["https://.../ref1", "https://.../ref2", "https://.../ref3"]
```

or the same order as multiple `blobs` / `$DATA` `files` entries with `"field": "imageUrls"`.

## After rhany.run

1. Check `status` is `SUCCESS` and `urls` is non-empty.
2. `web.fetch_file` `urls[0]` into the project right away.
3. Show / attach that project file. Do not wait, and do not rely on `saved[]` from the plugin if a `note` says the download failed.

## Do not

- Put `_inbox` paths into `rhany.run` `files`.
- Omit `resolution` or set it to empty on Dola Seedream.
- Invent endpoint suffixes.
- Leave the result only as a remote URL overnight.
- Patch `rhany` to request `$WORKSPACE` - the harness rejects that for agent-written plugins.
