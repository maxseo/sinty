# Human constructor

The constructor tab only listed widgets. A person could not create a page there, because the tab iframe may only GET.

## What changed

The Web UI bridge accepts `{ op: "post", path, body }` and forwards a JSON object to the same plugin's own route, with the staff token. It still refuses every other API path.

The Конструктор tab creates a draft (kind, title, slug), appends widgets in one column, and publishes. `POST /p/site/edit` writes the same rows as `site.write`, `site.layout` and `site.publish`. Saving from the tab collapses the tree into one column. The agent can still write a richer tree until the next human save.

## Why

The plan was that a person and the agent edit the same records. The agent tools were already there. The missing piece was a write path out of the sandboxed tab.

## Test

`plugins/site` typechecks. The bridge change is in the Web UI build. A click-through of the tab was not run in this change.
