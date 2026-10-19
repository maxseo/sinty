# syntet

Tools that call one Syntet site. Secret: `sinty secret set syntet.token`. Base URL defaults to `https://syntet.ru`; override `plugins.config.syntet.baseUrl`.

| Tool | HTTP |
|---|---|
| `syntet.whoami` | `GET /api/ai-agent/me` |
| `syntet.generations` | `GET /api/generations?kind=&limit=` |
| `syntet.record_usage` | `POST /api/usage` |

Paths are overridable (`whoamiPath`, `generationsPath`, `usagePath`) because the live site routes are still the n8n ones. These three are the first typed tools; image, video and kanban dispatch stay on n8n until each path is confirmed and switched (M7).

`syntet.record_usage` asks by default. Enable `syntet` in `plugins.enabled`.
