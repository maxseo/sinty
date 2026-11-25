# Golden prompts no longer advertise deprecated web.interact / web.screenshot

- Date: 2026-11-25
- Area: `packages/core` (`agent.toolSchemas`, golden snapshots, tool-web tests)
- Plan step: 0.5.2 isolated test fix after the Browser/Web split
- Commits: not committed (isolated 0.5.2 snapshot)
- PR: none

## What and why

After the Browser/Web split, `Agent.toolSchemas()` filters `web.interact` and `web.screenshot` out of the list offered to the model. The tools stay registered on tool-web for legacy/direct callers, with DEPRECATED descriptions pointing at `browser.control`. `browser-recovery-split.test.ts` already asserts that `web__interact` is not advertised.

The `memory-tools` and `compaction` goldens were still the pre-split lists (32 tools, including those two names). A leaf diff of actual vs expected showed only that change: every request still has the same messages, memory block, recall and compaction behaviour; tool lists went from 32 to 30 names, and the only names removed were `web__interact` and `web__screenshot`. The snapshots were regenerated for that advertised list. The tool-web default-on test was updated the same way: registration, schemas and descriptions of the five legacy tools plus `web.fetch_file` are still asserted; the wire list no longer expects the two hidden names, and an explicit check confirms they are not advertised.

## Files touched

- `packages/core/src/__tests__/golden/memory-tools.json`
- `packages/core/src/__tests__/golden/compaction.json`
- `packages/core/src/__tests__/tool-web.test.ts`
- this entry, `docs/journal/README.md`

## Design decisions

- **Update the expectation, do not put the deprecated tools back on the model list.** Hiding them is the agreed split: Browser is the advertised persistent tool; stateless web.screenshot / web.interact remain compatibility callers only.
- **Do not drop registration checks.** A later tool-web test still drives `web.interact` and `web.screenshot` and checks HTTP status / captcha flags.

## Rejected alternatives

- Treating the golden/wire failures as a product regression and removing the `toolSchemas()` filter. That would advertise the deprecated HTTP/headless fallbacks again and contradict the Browser plugin contract.
- Deleting the compatibility tools to make registration and the wire list match. Legacy callers and the existing interact/screenshot tests would break.

## Migration notes

None for existing installs. Models simply no longer see `web__interact` / `web__screenshot` in the tool list; `browser.control` is the advertised path.

## Known limitations

The compatibility tools can still be invoked by name if a caller already knows them. That is intentional.

## How to test

`node --test packages/core/dist/__tests__/golden.test.js packages/core/dist/__tests__/tool-web.test.js packages/core/dist/__tests__/browser-recovery-split.test.js`
