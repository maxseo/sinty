# Memory v1

Status: proposed. Not implemented. This document is the contract for a future plugin
`memory-v1`. It does not change the running memory router in `docs/spec/memory.md`.

The plugin stores short claims with proof, marks an old claim finished when a newer one
replaces it, and shows one agent's memory as a graph of spheres. The journal stays the
source of truth. The plugin is a projection that can be wiped and rebuilt.

## 1. What it is for

An agent should remember a fact across chats without treating the compacted window as evidence.
A person should open the agent's card and see, without reading a table, which facts belong
together, what kind they are, and which ones are fading.

v1 is one plugin. It does not replace `memory.write`, `memory.recall`, or `memory.forget`.
Those names stay reserved by the core. The plugin is a memory provider and a processor on
the existing router, plus one card tab.

## 2. What a sphere is

A sphere is one **claim**: one sentence about one subject.

| Field | Meaning |
|---|---|
| `id` | Opaque `mem_*`. The model never sees a database key. |
| `userId` | Account that owns the claim. The model never sends it. The host copies it from the turn. Local harness uses `config.agent.userId` (default `local`). A shared cloud instance uses the signed-in account id. |
| `agentId` | Roster persona the claim belongs to. Required even when `scope` is `user`, so the card of one agent can filter. |
| `text` | One sentence, at most 500 characters. |
| `kind` | `fact`, `preference`, `decision`, `open`. This is the sphere color. |
| `subject` | Who or what it is about: a person label, a project path, or `none`. |
| `scope` | `user`, `agent`, `project`, or `chat`. Same visibility rules as `docs/spec/memory.md`. |
| `evidence` | Pointers into the journal of this turn: a user message id or a tool-result id. Compacted summary text and the model's own reasoning are not evidence. |
| `basis` | `user_requested` or `agent_inferred`. |
| `validFrom` | When this wording became the current one. |
| `validTo` | When a newer claim closed it. Empty means current. |
| `salience` | 0..1. How easy it is to recall, and how bright the sphere is. |
| `links` | Other `mem_*` this claim supports, contradicts, or continues. A link is not a copy of the text. |

A claim is saved whole or not at all. A repeat of the same normalized text in the same scope
and subject does not create a second sphere. It adds evidence and refreshes salience.

When the same subject and the same kind are said differently, the old claim gets `validTo`
and stays in the store. The new claim is the one search returns. Both spheres stay on the
graph: the closed one is dim and dashed. The model does not pick a winner when two current
claims contradict. The prompt shows the pair and asks the person.

## 3. How a claim is written

Two doors, one check.

1. The speaking agent calls the plugin tool `memory_v1.remember` in the turn. A child
   `agent.task` does not receive this tool. It sees a slice of the task, not the conversation.
2. After the turn, the plugin may propose claims from the raw user text and tool results of
   that turn only. A proposal is stored only when every evidence id was actually in the turn.
   The proposal is `agent_inferred`. It never reads the model's hidden reasoning.

The core still journals the write (`memory.*`). Secrets, tokens, and payment data are refused
before insert. If the evidence check fails, nothing is written and the tool returns a stable
error code. There is no silent fallback.

## 4. How a claim is forgotten

Forgetting is a number, not a deletion.

- A claim starts at salience 1 when the person asked to remember it, and at 0.6 when the
  agent inferred it.
- Each day without recall or new evidence multiplies salience by 0.98.
- A successful recall or a repeated mention sets it back toward 1, but not above 1.
- Search skips claims under 0.15 unless the person opens the graph and asks to include faded
  ones. The row remains.
- `validTo` is a hard close. It is brighter than decay: the fact was replaced, not merely
  unused. Closed claims are out of default search.

Nothing is removed because two sentences look similar. Embeddings rank search. They do not
merge claims and they do not set `validTo`.

## 4.1 What crosses into a new chat

A claim has a home, set by the host at write time. The model does not choose it.

| Home | What belongs there |
|---|---|
| `chat` | A turn, a decision, or an open question of this conversation. |
| `project` | Something about this project. |
| `user` | Something true in every chat and project: name, language, stable preferences. |

The agent card stores one recall policy. Memory of the open chat is always included.

| Mode | A new chat may recall |
|---|---|
| `chat` | Nothing from other chats or projects. |
| `project` | This chat, other chats of the same project, and the user card. Other projects stay closed. |
| `agent` | The project mode, plus homes explicitly ticked below from other projects. |

Ticks apply only when a claim crosses a chat boundary. They are hidden in `chat` mode.

- `aboutUser` — user-home claims. On in the default.
- `projectWork` — decisions and open questions from other chats of the same project. On in the default.
- `otherProjects` — facts and decisions from other projects. Off in the default.

The default mode is `project` with `aboutUser` and `projectWork` on and `otherProjects` off.
The graph may still draw claims the policy hides. Those spheres are dimmer and labeled with
their home. They are not inserted into the turn.

## 5. How a claim is read

Before the first model step, the router recalls as it does today. This plugin adds its own
hits after the builtin store, marked untrusted, the same way other providers do.

Search is three branches, each with its own cutoff, then reciprocal rank fusion:

- Russian full text, including word forms;
- exact tokens for names, paths, and codes;
- a vector over the claim text, only if an embed route is already configured. No network call
  of the plugin's own. The model id is stored beside the vector. A model change does not mix
  old and new vectors.

At most 12 current claims go into the prompt, as data, not as instructions. If the plugin
store cannot be read, the block says the memory plugin is unavailable. It does not say the
list is empty.

The speaking agent may call `memory_v1.search` up to three times in a turn, each time for a
different aspect, when the automatic block was not enough.

## 6. The card tab

The screenshot places the tab on the agent card, in the bar that already has **Общее**,
**Плагины**, **Навыки**, **MCP**, immediately before **Сохранить**.

That bar is not a plugin surface today. `ui.tabs` placements are `sidebar`, `session`,
`project`, `settings`, and `plugins`. v1 adds one placement:

| Manifest | Where |
|---|---|
| `ui.tabs[]` with `id: "graph"`, `title: "Память"`, `placement: "agent"` | Agent card bar, after MCP, before Сохранить |

The page receives the open `agentId`. It shows only claims whose scope is `user`, or `agent`
for this persona, or `project` / `chat` that this persona is allowed to see. Switching agents
reloads the graph. A disabled plugin shows no tab.

The right id is `ui:memory-v1/graph`. Changing the tab id is a new right.

The page is a normal sandboxed plugin tab (`tab/1`). It does not get core catalog or install
rights. The graph is read-only in v1. Closing, editing, and deleting stay on the tools and
on a later version of the tab.

### Graph

`GET` the plugin's graph for the open agent. The payload is nodes and edges, already filtered
by scope. The page does not compute access itself.

- One node is one sphere: label (the claim text, truncated), `kind`, `salience`, `closed`.
- One edge is one link: `supports`, `contradicts`, or `continues`.
- Color is only `kind`: fact, preference, decision, open question. The same four colors in
  light and dark theme. Color is never used for scope or for trust.
- Brightness is `salience`. A fresh claim is solid. A faded claim is the same color, lower
  opacity. A closed claim is the dimmest and its edges are dashed.
- Hover or click shows the full sentence, when it was written, whether it is still current,
  and the evidence quote. No second summary is generated for the card.
- Layout is a force graph: linked spheres pull together, the rest spread. It is a view, not
  a stored coordinate. v1 does not animate history.

Empty state: a short line that this agent has no claims yet, not an error.

## 7. Tools

| Tool | Who | Effect |
|---|---|---|
| `memory_v1.remember` | root agent of the turn | Insert or reinforce one claim, optional links. |
| `memory_v1.search` | root agent | Hybrid search beyond the automatic block. |
| `memory_v1.close` | root agent, only with a `mem_*` the turn was shown | Set `validTo` on that claim. |

`sideEffects: true` and `idempotent: false` on `remember` and `close`, except that a replay
of the same operation key returns the previous result and does not write a second row.
`search` is `sideEffects: false`, `idempotent: true`.

Inputs are JSON Schema at the tool boundary and checked with zod inside the plugin.
Subjects and scopes the model is not allowed to name are filled by the host from the turn,
not from model fields.

## 8. Plugin shape

```json
{
  "name": "memory-v1",
  "version": "0.1.0",
  "categories": ["functional"],
  "permissions": ["memory.read", "memory.write"],
  "hooks": ["memory"],
  "ui": { "tabs": [{ "id": "graph", "title": "Память", "placement": "agent", "path": "/graph" }] }
}
```

Exact permission strings follow the manifest schema at implementation time. The plugin does
not request shell, browser, env, or network. Embeddings, if used, go through the core model
gateway.

## 8.1 Store

One SQLite file per harness instance, in the plugin data directory: `memory-v1.db`.
Local and cloud use the same schema. They do not get different databases.

The local app is one instance and usually one user (`local`). The cloud app is one instance
with many accounts, and each account has many agents. Every row carries `user_id` and
`agent_id`. Both are `NOT NULL`. Every read and every write filters `user_id` first, taken
from the host session, never from the model or from the tab query string. A graph request
for an agent checks that this agent belongs to that user before returning nodes.

Wiping the file does not touch the journal. A later rebuild may re-read journaled `memory.*`
events; v1 does not have to ship that rebuild.

Tables:

| Table | Rows |
|---|---|
| `claims` | One sphere. Primary key `id`. Columns include `user_id`, `agent_id`, `scope`, `project_id`, `chat_id`, `kind`, `subject`, `text`, `text_norm`, `basis`, `salience`, `valid_from`, `valid_to`, `embed_model`, `embed_dims`. |
| `evidence` | One proof. `claim_id`, `user_id`, journal message or tool-result id, short quote. |
| `links` | One edge. `user_id`, `from_id`, `to_id`, `rel` (`supports`, `contradicts`, `continues`). Both ends must be claims of the same `user_id`. |
| `operations` | Idempotency. `user_id`, operation key, input hash, result. Survives a deleted claim so a replay does not recreate it. |

Indexes: `(user_id, agent_id, valid_to)`, `(user_id, agent_id, text_norm)`, FTS5 on `text`.
Vectors, when an embed route exists, live in a sqlite-vec table keyed by `claim_id` and are
never searched across users. `user_id` on `evidence`, `links`, and `operations` is deliberate
duplication so a query cannot join itself into another account's rows.

## 9. Out of scope for v1

- Family, group, and Telegram review lanes from the Osinara design.
- A knowledge-graph database.
- Automatic merge of similar sentences.
- An LLM summary of a thread. Links are the only grouping.
- Editing spheres on the card.
- Sub-agent writes.
- Replacing the builtin profile, log, and note tiers. They keep working. This plugin adds
  claims beside them.
