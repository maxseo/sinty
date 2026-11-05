# Context inspector FakeEl querySelector

- Date: 2026-11-05
- Area: context-inspector
- Plan step: none
- Commits: this commit
- PR: #85

## What and why

CI on `feat/runninghub` failed four `session tab page` tests with `no request for /^\/snapshots\/…$/; sent []`. Commit `23e5d59` made `drawSteps` call `box.querySelector(".step.on")` so the active step scrolls into view. The page harness `FakeEl` had no `querySelector`, so the call threw, `refresh` swallowed it in `.catch`, and `open` never asked for the snapshot.

## Files touched

- `plugins/context-inspector/src/page.test.ts` — `FakeEl.querySelector` for class selectors such as `.step.on`.

## Design decisions

Keep the real `querySelector` in the page. Teach the harness the one selector shape the page uses.

## Rejected alternatives

Removing the scroll call. The live tab needs it when many steps pile up.

## Known limitations

The fake only matches class selectors. Tag or id selectors are not needed yet.
