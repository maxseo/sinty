# tool-fs

Files in the workspace (`$SINTY_HOME/workspace`) and the skills folder (`$SINTY_HOME/skills`). Paths are relative to the workspace; prefix `skills:` targets the skills folder, e.g. `skills:report/SKILL.md`.

| Tool | Does | Errors |
|---|---|---|
| `fs.read` `{ path, offset?, limit? }` | numbered lines, up to 2000 per call | `not_found`, `is_directory`, `too_large`, `outside_workspace` |
| `fs.list` `{ path?, depth? }` | entries, folders end with `/` | `not_found` |
| `fs.write` `{ path, content }` | atomic write, creates folders | `outside_workspace` |
| `fs.edit` `{ path, old, new, replaceAll? }` | exact fragment replace | `no_match` (re-read the file), `not_unique` (add context or `replaceAll`) |

The process can physically write only to these two folders (Node.js permission model).
