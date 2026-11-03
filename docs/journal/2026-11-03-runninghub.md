# RunningHub is a text provider and a settings catalog

- Date: 2026-11-03
- Area: plugins/runninghub
- Plan step: none
- Commits: this commit
- PR: (open)

## What and why

RunningHub has two protocols. Language models speak OpenAI-compatible chat at `https://llm.runninghub.ai/v1`, so they are one more provider on Settings → Models, next to OpenRouter, with the same Enterprise-Shared key. Image, video, audio and 3D models are tasks: upload, submit, poll. Those live in plugin `runninghub`. The catalog opens as the RunningHub item in Settings, not in the left navigation. A later syntet.ru plugin can keep the same shape and change the two base addresses.

Model ids from that catalog contain a slash (`openai/gpt-6.1-sol-saver`). The route check now allows slashes after the provider name. The provider is still the first segment.

## Files touched

- `plugins/runninghub/`
- `packages/core/src/config.ts`
- `packages/sdk/src/plugin.ts`
- `packages/core/src/host/manifest.ts`
- `schemas/plugin-manifest.schema.json`
- `apps/web/src/supervisor-ui.tsx`
- `apps/web/src/pages.tsx`
- `apps/web/src/plugin-tab.tsx`
- `apps/web/src/style.css`

## Design decisions

The catalog page is a plugin tab with `placement: settings`. The settings section of the same plugin is replaced by that page, so the item sits with Основные and Модели. The official MCP server only reads schemas and does not run a task, so the plugin runs the contract itself: `POST /media/upload/binary`, `POST /{endpoint}`, `POST /query`. The registry file is downloaded into the plugin data directory. Two seed models are enough for the page before that download.

The key is `secret://runninghub`, the name the Models card writes when the provider id is `runninghub`. The catalog does not ask for a second key.

## Rejected alternatives

Putting every generative model on the Models card. That card only lists chat routes.

Installing `developer-kit/mcp-server` as the agent's way to generate. It does not upload, submit or poll.

## Migration notes

Add the provider with «Добавить RunningHub» on the Models page if it is not there, paste the Enterprise-Shared key, and save. Enable the plugin and restart `sinty web`. Allow `llm.runninghub.ai`, `www.runninghub.ai` and `raw.githubusercontent.com` in `policy.yaml`. Then Ctrl+F5. Open Settings → RunningHub and press «Обновить реестр».

## Follow-up: a large chat file is streamed, not base64

Attaching a file read the whole thing into a base64 string, so a 118 MB file closed the tab with Out of Memory. The upload is now the file itself. The server writes it in chunks, up to 512 MB, and the project copy goes to `_inbox`. A file larger than 8 MB is named in the prompt and is not pasted into the model.

## Follow-up: no busy line under a queued message

A message sent while the agent is still working stays in the transcript. The chat no longer adds «Ход занят. Это сообщение дождётся конца текущей команды.»

## Follow-up: supervisor remarks leave the chat

The chat no longer draws `supervisor.notice` and `supervisor.escalated`. Those stay on the Supervisor tab. When the sidebar says a chat is waiting, the transcript shows one line: the question, the tool to approve, or a request to send a message and continue.

## Follow-up: a project file was reported as outside the project

`runninghub.run` resolved `_inbox/…` from the process folder, then refused the chat's own voice sample in «Рилс». A relative path is now resolved from the project directory. A path that leaves that directory is still refused.

## Follow-up: generated files play in the chat

RunningHub writes each result under the project folder `_out/generation/<task id>/`. The core records `chat.media` for those files, and the chat draws them: audio with a play button and an equalizer, video with play, a scrubber and fullscreen, a picture with rounded corners that opens to the full screen. A 3D preview is not in this pass. The model does not see `chat.media`.

## Follow-up: the catalog page did not run its script

The history row built its detail text with `"\n\n"` inside the HTML template. That escape became a real line break in the page, so the script failed to parse. The buttons stayed inert and the model list never loaded. The page now emits the two-character escape, and a test checks that the script parses.

## Follow-up: tools and a generation log

`runninghub` is a default-on plugin, so an agent card does not have to list it. `runninghub.search`, `runninghub.schema` and `runninghub.run` are on every agent unless the card excludes the plugin. Each run is a row in the plugin data database (`generations.db`): task id, endpoint, status, start, duration, error, and coins or dollars when the response includes them. Settings → RunningHub → История shows the table.

## Follow-up: the submit response

A refusal comes back as HTTP 200 with `errorCode` and `errorMessage`, and a success may put `taskId` under `data`. The first client only read a top-level `taskId`, so the chat saw «задача не создалась (200)» and the agent repeated the call until the supervisor stopped the turn.

## Follow-up

The public registry has `class_name` and `display_name`, not `id`, and a list option is `{ value }`. The first parser dropped every row, so the page stayed on the two seed cards. Opening the section now downloads the file. A provider base URL that is not a URL is skipped, so that card cannot stop the server from starting.

## Known limitations

AI Apps and workflows are not in the standard-model registry. A result file larger than 20 MB, or hosted on a name that is not in `net.allow`, is returned as a URL. Prices are not shown.

## How to test

`node --test plugins/runninghub/dist/registry.test.js` and `node --test packages/core/dist/__tests__/model-route.test.js` after the builds. In the harness, the Models card lists RunningHub text models after the key is saved, and Settings → RunningHub lists standard models after the registry refresh.
