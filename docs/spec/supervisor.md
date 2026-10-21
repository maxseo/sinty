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
| `tool_error` | `tool.call.failed` with the tool's own error | done |
| `external_error` | `tool.call.failed` with a code from `EXTERNAL_ERROR_CODES` (`http_4xx`, `http_5xx`, `too_large`, `timeout`, `net_failed`): the target site or the network refused. Never stops the turn and never counts toward `maxNoticesPerTurn`; past `maxNoticesPerDetector` its notices are just not sent. No docs, no incidents, no patch suggestion | done |
| `invalid_args` | schema validation failed before the call | done |
| `interrupted` | resume found a tool call with unknown outcome (`code: interrupted`) | done, as a `tool_error` notice with a "check the state first" hint |
| `loop` | same tool with the same arguments ≥ `loopThreshold` times; `loopBlockAfter` (default `loopThreshold + 2`) escalates | done |
| `budget` | `budget.warnAt` (80%) of the step or token budget → notice. 100% → the core blocks the turn with reason `budget` (`budget.stop: false`: warning only) | done |
| `bad_output` | empty final answer, or output cut off (`stopReason` `length` / `max_tokens`) | done |
| `stall` | a model or tool call silent for `stallSeconds` → notice; twice as long → the call is aborted (`stallBlock`). Runs in the core | done |
| `provider` | provider error rate or latency above threshold → `model.fallback` | planned; the core already falls back on errors |

## Notice

```text
[supervisor] Pay attention: tool flaky.get failed (bug: flaky.get is broken).
Hint from the tool: the plugin has a bug
Think about why it failed before calling it again.
Tool docs (README.md, section flaky.get):
  <the section under the heading that names the tool, else the start of the file; docsMaxChars at most>
A similar incident was solved before: after bug ("…") the call worked with arguments {...}
Propose a fix: correct the arguments, choose another approach, or explain to the user what is blocking you.
```

The docs file is `tools[].docs` from the manifest, otherwise the plugin's `README.md`. A notice carries a tool's docs once per turn (the model keeps them in its history); the section is the one under a heading that names the tool (`## web.read`, `### \`web.read\``), up to the next heading of that level.

An `external_error` notice says the site or network refused, quotes the tool's hint and suggests another source; it carries no docs or incidents.

## Escalation ladder

| Level | Trigger | Action |
|---|---|---|
| 1. Hint | first failure | notice with hint, docs and similar incidents |
| 2. Strategy | same tool, code and target (url host, or the first of `path`, `file`, `command`, `query`, `name`, `id`) failed `repeatFailures` (2) times in the turn | notice: do not repeat, change the approach |
| 3. Patch | the tool failed with its own errors (not `external_error`) in ≥ `patchAfterTurns` (3) different turns and its plugin is editable | notice suggesting `plugin.read` → `plugin.propose_patch` |
| 4. Human | more than `maxNoticesPerDetector` (2) notices from one detector or `maxNoticesPerTurn` in total (`external_error` excluded), or a hard loop; with `escalate: false` extra notices are dropped instead | `supervisor.escalated` + `turn.blocked{reason: supervisor}` |

A blocked turn (reason `supervisor` or `budget`) continues when a human sends a message to the session: the message is recorded in the same turn, and the step, token and time budgets and the supervisor counters restart from it.

## Incident memory

When a turn completes, the supervisor looks for failed calls that a later call of the same tool corrected: the same target (url host, or the first target-like argument), or any call when the failed one named no target (say, a missing argument). Another site read after a failure is not a fix. External errors (`EXTERNAL_ERROR_CODES`) and `interrupted` are never stored. It reports `{ tool, code, message, fixSummary }`, which says which arguments worked. The core stores this in the `incidents` table and records `supervisor.incident_resolved`. A later failure quotes the last two incidents with the same tool, code and message key (masked, one line, urls cut to their host, numbers of 4+ digits dropped), skipping incidents whose fix names a url on another host than the failing call. Summaries written by a model come later.

On its first start with this rule the core drops the `web.*` incidents with code `web_failed` stored by the old rule (journal `migrations` row `2026-10-21-drop-web-failed-incidents`).

## Masking

Incidents and notices never carry raw arguments. Before anything is stored or quoted (`packages/supervisor/src/scrub.ts`):

- values of secret-looking keys (`password`, `token`, `secret`, `apiKey`, `authorization`, `cookie`, `pin`, …) become `[hidden]`;
- text typed into a page (`web.interact` actions `type`, and `fill` / `input` / `insert` / `setValue` in other tools) becomes `[hidden]`;
- secret query parameters and known token shapes (`sk-…`, `ghp_…`, `xox…`, JWTs, `Bearer …`) become `[hidden]`;
- long string values are cut to 120 characters (`…[N chars]`), long JSON values in older texts to 80.

The core also passes incident texts through the secret store's redaction, rewrites incidents stored before masking existed when it starts, and masks `supervisor.*` texts again when `/v1/supervisor` serves them. Journal events themselves stay append-only: the chat's «Журнал» tab still shows the raw arguments of that chat's tool calls.

## Configuration

Stored in `config.yaml` (core-owned) and editable in the Web UI: Settings → **Супервизор**. Changes apply at the next checkpoint without a restart, except `enabled`.

```yaml
supervisor:
  enabled: true
  loopThreshold: 3          # identical calls before a loop notice
  # loopBlockAfter: 5       # identical calls before the turn stops; default loopThreshold + 2; 0 never
  stallSeconds: 180         # silence before a warning; 0 off; agents may set their own
  stallBlock: true          # abort the silent call after twice stallSeconds
  maxNoticesPerTurn: 6
  maxNoticesPerDetector: 2
  escalate: true            # false: never stop the turn for notice limits or loops, just stop sending notices
  repeatFailures: 2         # same tool + code + target in a turn before "do not repeat" (level 2)
  patchAfterTurns: 3        # turns a tool failed in before the patch suggestion (level 3); 0 never
  docsMaxChars: 500         # tool docs quoted in a notice (the tool's section, once per tool per turn); 0 none
  useIncidents: true        # quote earlier fixes of the same error on the same target
  checks: { toolErrors: true, loop: true, budget: true, badOutput: true }
  budget:
    # steps: 60             # unset: policy.yaml budgets.turn; 0 = no limit
    # tokens: 600000
    # seconds: 1200
    count: weighted         # weighted | uncached | all
    cachedWeight: 0.1       # weight of a cached prompt token for "weighted"
    warnAt: 0.8             # notice at this share of the step or token budget
    stop: true              # false: warn, never block
```

`checks.budget` turns off only the warning notice; the hard stop is `budget.stop`.

### What a budget token is

With prompt caching a long turn re-reads the same prefix on every step. Counting every prompt token (`all`, the behaviour before this setting) makes a 60-step turn with a 10k-token context "spend" 600k tokens while the provider bills most of them at a tenth of the price. The default `weighted` counts `input − cached + output + cached × cachedWeight`, which tracks cost for DeepSeek, OpenAI and Anthropic (cache reads at about 10% of the input price) without needing per-model prices. `uncached` ignores cached tokens entirely. A dollar budget is not offered yet: providers do not report `costUsd`.

`policy.yaml budgets.turn` still works and is the fallback for numbers not set in `config.yaml`.
