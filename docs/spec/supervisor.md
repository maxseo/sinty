# Supervisor

A system process started and restarted by the core. Part of the protected core; not a plugin; not editable by the agent.

It reads the event bus, keeps per-turn statistics and may write only these events: `supervisor.notice`, `supervisor.escalated`, `supervisor.incident_resolved`, and the control actions `turn.blocked` and `model.fallback`.

## Detectors

| Detector | Fires when |
|---|---|
| `tool_error` | `tool.call.failed` |
| `invalid_args` | schema validation failed before the call |
| `loop` | same tool with the same arguments ≥ 3 times in a turn, or the same error ≥ 2 times |
| `stall` | a step runs longer than its tool timeout or the turn makes no progress for `stallSeconds` |
| `budget` | 80% of a budget (warning) or 100% (block) |
| `bad_output` | empty answer, truncated output, malformed tool call JSON |
| `provider` | provider error rate or latency above threshold |
| `interrupted` | resume found a tool call with unknown outcome |

## Notice

A notice is a journaled event; the next `context.build` places it right after the failing step:

```text
[supervisor] Pay attention: step 14, tool syntet.generate_image failed (http_422: "width must be integer").
Think before retrying. Tool docs:
  <first 1500 chars of the tool docs file from the plugin manifest>
Similar incident #31 was solved by: casting width/height to integers.
Propose a fix: correct the arguments, choose another approach, or propose a patch to the plugin.
```

Docs are resolved in order: `tools[].docs` → plugin `README.md` → matching skill `SKILL.md`. Incident memory is a similarity search over `incidents` (tool, error code, normalized message).

## Escalation ladder

| Level | Trigger | Action |
|---|---|---|
| 1. Hint | first occurrence | notice with docs and similar incidents |
| 2. Strategy | repeated after hint | notice asking to change approach; for `provider` and `bad_output` — `model.fallback` to the next model |
| 3. Patch | same tool fails across turns | notice suggesting `plugin.propose_patch` with the collected evidence |
| 4. Human | still failing, budget exhausted, or `interrupted` with external side effects | `turn.blocked` + `supervisor.escalated`; channels show "Needs decision" |

Limits: at most 2 notices per detector per turn and 6 per turn in total; after that the supervisor goes straight to level 4. This prevents supervisor-driven loops.

## Incident memory

When a turn that had notices completes successfully, the supervisor stores `{ tool, code, message, fix_summary }` and emits `supervisor.incident_resolved`. The summary is produced by the `cheap` model route.

## Configuration

```yaml
supervisor:
  loopThreshold: 3
  stallSeconds: 180
  maxNoticesPerTurn: 6
  docsMaxChars: 1500
```

Stored in `config.yaml` (core-owned).
