# Settings → Models: named routes UI + merge-safe persist

## Context

Max reported that Settings → Models used to have selectors for specialized routes
(vision, decision, etc.) and now only shows default + «Включённые маршруты» +
providers. He asked why the earlier work was wiped and how to prevent recurrence.

## Investigation

- Git history / blame / stashes / `wip/*` branches: **no Models UI for
  `models.routes.*` ever landed on main**. Docs and gateway already define named
  routes (`cheap`, `embed`, plus `vision` / `long` in integrations.md). The agent
  card has `serviceModel`; that is per-agent, not the Models tab.
- Live `~/.sinty/config.yaml` and the 2026-10-20 backup both have `routes: {}` —
  named routes were never filled on this install.
- Confusing label: «Включённые маршруты» was the **enabled catalog**
  (`models.catalog`), not `models.routes`.
- Real wipe bug found next to this: Models/Plugins saves called
  `PUT /v1/settings` with `fallback: []`, which **cleared `models.fallback`**.

## Change

- Settings → Models: section **Именованные маршруты** for `cheap` / `embed` /
  `vision` / `long`, plus `service.model`. Catalog heading renamed to
  **Включённые модели**.
- `GET/PUT /v1/models` expose and deep-merge `models.routes` (`saveNamedRoutes`).
  Omitted keys preserved; empty string clears only the patched key; custom keys
  outside the form survive.
- `saveSettings` / `PUT /v1/settings`: omitted `fallback` no longer overwrites
  `models.fallback`. Web UI stops sending `fallback: []` on Models/Plugins save.

## Follow-ups

- tool-vision plugin should default to route `vision` → `default`.
- Optional: show custom `models.routes` keys beyond the well-known four.