# ui-web

Static Web UI served at `/ui/ui-web/` (and `/` redirects here). `editable: false`, so the agent cannot patch it, and the core will serve it.

The bundle is built from [`apps/web`](../../apps/web) into `public/`. That folder is gitignored; after a clone run `pnpm build` at the repo root.

Pages: chat with a live stream, sessions, inline approvals, journal, supervisor (notices, incidents, patches), kanban (`/p/kanban`), plugins.

The API token is taken from the `#token=` fragment that `sinty web` prints, or typed on the login screen. It is stored in `localStorage`, never in a cookie.
