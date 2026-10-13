# example-echo

Reference plugin. Copy this folder to start a new one.

## Tools

### `echo.say`

| Argument | Type | |
|---|---|---|
| `text` | string, ≤ 10 000 chars | required, not blank |
| `upper` | boolean | optional |

Errors: `empty_text` — `text` is blank.
