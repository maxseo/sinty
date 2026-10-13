# Web UI

Vue 3 + Vite single-page app served by the `channel-web` plugin. Milestone M3.

Views: chat with sessions, live journal, approvals, supervisor panel, kanban (cards are tasks; any number of agents can be assigned), agents list with states, settings (models, plugins, policy viewer).

Talks only to the public API ([protocol](../../docs/spec/protocol.md)), so it can be replaced or embedded into another app.
