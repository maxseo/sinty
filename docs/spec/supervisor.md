# Supervisor

A system process started and restarted by the core (`packages/supervisor`). It is part of the protected core: not a plugin, and the agent cannot edit it. It runs under the Node permission model and can only read the install folder and `$SINTY_HOME/plugins` (for tool docs). It has no network or write access.

The core forwards every journal event to it over IPC. The supervisor never writes to the journal. At two checkpoints the core asks it for actions and records them:

| Checkpoint | When | Typical actions |
|---|---|---|
| `before_model` | before every model call | notices about failed tools, loops and budget |
| `before_complete` | before the final answer is accepted | notice about an empty or truncated answer |

Actions are `notice` (recorded as `supervisor.notice` and shown to the model as a `[supervisor] …` user message) and `escalate` (recorded as `supervisor.escalated`, and the turn is blocked with reason `supervisor`). If the supervisor is down or does not answer within 3 s, the checkpoint returns no actions and the turn continues. The core restarts the supervisor with backoff and replays the events of open turns.

## Detectors

| Detector | Fires when | Status |
|---|---|---|
| `tool_error` | `tool.call.failed` | done |
| `invalid_args` | schema validation failed before the call | done |
| `interrupted` | resume found a tool call with unknown outcome (`code: interrupted`) | done, as a `tool_error` notice with a "check the state first" hint |
| `loop` | same tool with the same arguments ≥ `loopThreshold` times; `loopThreshold + 2` escalates | done |
| `budget` | 80% of the step or token budget → notice. 100% → the core blocks the turn with reason `budget` | done |
| `bad_output` | empty final answer, or output cut off (`stopReason` `length` / `max_tokens`) | done |
| `stall` | no progress for `stallSeconds` | planned |
| `provider` | provider error rate or latency above threshold → `model.fallback` | planned; the core already falls back on errors |

## Notice

```text
[supervisor] Pay attention: tool flaky.get failed (bug: flaky.get is broken).
Hint from the tool: the plugin has a bug
Think about why it failed before calling it again.
Tool docs (README.md):
  <first docsMaxChars of the tool docs file>
A similar incident was solved before: after bug ("…") the call worked with arguments {...}
Propose a fix: correct the arguments, choose another approach, or explain to the user what is blocking you.
```

The docs file is `tools[].docs` from the manifest, otherwise the plugin's `README.md`.

## Escalation ladder

| Level | Trigger | Action |
|---|---|---|
| 1. Hint | first failure | notice with hint, docs and similar incidents |
| 2. Strategy | same tool and code failed twice in the turn | notice: do not repeat, change the approach |
| 3. Patch | the tool failed in ≥ 3 different turns and its plugin is editable | notice suggesting `plugin.read` → `plugin.propose_patch` |
| 4. Human | more than `maxNoticesPerDetector` (2) notices from one detector or `maxNoticesPerTurn` in total, or a hard loop | `supervisor.escalated` + `turn.blocked{reason: supervisor}` |

A blocked turn (reason `supervisor` or `budget`) continues when a human sends a message to the session: the message is recorded in the same turn, and the step, token and time budgets and the supervisor counters restart from it.

## Incident memory

When a turn completes, the supervisor looks for tools that failed and then succeeded in that turn. It reports `{ tool, code, message, fixSummary }`, which says which arguments worked. The core stores this in the `incidents` table and records `supervisor.incident_resolved`. Later failures of the same tool with the same error code include the last two such incidents. Matching is exact on tool and code. Summaries written by a model come later.

## Configuration

```yaml
supervisor:
  enabled: true
  loopThreshold: 3
  stallSeconds: 180    # reserved for the stall detector
  maxNoticesPerTurn: 6
  docsMaxChars: 1500
```

Stored in `config.yaml` (core-owned).
