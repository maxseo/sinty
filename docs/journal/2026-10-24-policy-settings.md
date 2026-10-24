# Policy settings UI (defaults / mode in РќР°СЃС‚СЂРѕР№РєРё)

- Date: 2026-10-24
- Area: packages/core (settings-sections, API), packages/sdk, apps/web, docs/spec/policy.md
- Plan step: Max asked for В«РїР»Р°РіРёРЅ РЅР°СЃС‚СЂРѕРµРє policy (trust / РЅРµ СЃРїСЂР°С€РёРІР°Р№)В» after #25/#26 retests
- Commits: this commit
- PR: [#27](https://github.com/maxseo/sinty/pull/27) (`577cd9c`)

## Why

Session policy trust (#24) already skips `ask` in a chat. The durable defaults still lived only in `$SINTY_HOME/policy.yaml`, and РќР°СЃС‚СЂРѕР№РєРё в†’ РћР±С‰РёРµ had a В«Р”РѕСЃС‚СѓРїВ» select (full/ask/read) that wrote only `localStorage sinty.prefs` and never touched policy. Max wanted a settings surface for trust / В«РЅРµ СЃРїСЂР°С€РёРІР°Р№В» durable defaults.

## Design: core section, not a plugin

`docs/spec/policy.md`: policy.yaml is **core-owned**; no tool may write it. Plugin `settings` in the manifest write `plugins.config.<name>` in config.yaml вЂ” the wrong store for policy. Authenticated `PUT /v1/settings/sections/:id` already rewrites YAML through `parseDocument` (supervisor, memory). Extending that with a core `policy` section that targets `paths.policy` keeps one write path and respects core ownership. A thin plugin that only declared UX would still need a core write hook; skipped for v1.

Session trust (phrase / remember / В«Р‘РѕР»СЊС€Рµ РЅРµ СЃРїСЂР°С€РёРІР°С‚СЊ РІ СЌС‚РѕРј С‡Р°С‚РµВ» / Allow all) is **not** moved here вЂ” it stays session-scoped and does not edit the file.

## What changed

- `POLICY_SECTION` in `settings-sections.ts`: `mode` + `defaults.{none,read,write,external}`; `store: "policy"`; `assignPolicy()` mutates the live object agent/host share.
- `PUT /v1/settings/sections/policy` reloads policy.yaml (comments preserved), applies live; invalid values 400 and restore the file.
- SDK `SettingsSection.store?: "config.yaml" | "policy.yaml"`.
- Web: section appears in settings nav; save notice names the file; РћР±С‰РёРµ dead В«Р”РѕСЃС‚СѓРїВ» replaced with a link to РџРѕР»РёС‚РёРєР°.
- Spec + tests: `policy-settings.test.ts`.

## Out of scope / follow-ups

- Editing `tools:` / `paths:` / `net:` / `agents.*` maps in the UI.
- Per-agent policy UI.
- `web.fetch_file`.
- Wiring РћР±С‰РёРµ presets as one-click writers (full/ask/read в†’ four defaults); help text documents the mapping instead.

## Migration / retest on PC

- Rebuild `packages/sdk` + `packages/core` (`tsc`) before `stage.mjs` if installing; rebuild `apps/web` into `plugins/ui-web/public`, then stage + install (UI changed).
- Or, for a running install already on main tip: after merge/reinstall, open РќР°СЃС‚СЂРѕР№РєРё в†’ РџРѕР»РёС‚РёРєР°, change writeв†’allow, save, confirm policy.yaml and that the next tool with write sideEffects no longer asks (unless tools: override / sensitive path). Confirm РћР±С‰РёРµ no longer has the dead Р”РѕСЃС‚СѓРї select.
