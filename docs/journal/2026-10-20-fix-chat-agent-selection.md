# Chat agent selection: the chat's own agents decide who speaks

- Date: 2026-10-20
- Area: packages/core (`Agent.speaker`, context snapshot), packages/sdk (`ContextSnapshot.persona`), apps/web (chat header), plugins/context-inspector
- Plan step: Part 1 of the prompt-cache report (`sinty-prompt-cache-report.md`, 20.10.2026), approved by Max
- Commits: `fix(core): pick the chat's agent from session agentIds before the project`

## What and why

Max edited the AGENTS.md field of his agent «Синтия» in the Web UI, but the **Контекст** tab kept showing the old
text. The snapshot was not stale: it showed exactly what the model got. The bug was in who the core thought was
speaking.

- The Web UI saves the persona correctly, into the agent card in `data/roster.json` (`persona`).
- The Web UI creates a project chat with `metadata: { agentIds: [...] }` and shows those agents as the chat members
  (`apps/web/src/app.tsx`, `chat.tsx`).
- The core (`Agent.speaker`, `packages/core/src/agent.ts`) looked only at the **project**: an asked `agentId` had to be
  in `project.agentIds`, otherwise `project.leadId`. Sessions without a project had no speaker at all.
- Max's project «первый» (`prj_2cdedd62`) was created with the sidebar "+", which saves only a name: `agentIds: []`,
  `leadId: ""`. So the asked agent `agt_331f7075` was rejected, the empty lead matched nothing, and the speaker was
  `undefined`.

With no speaker the core used the global `~/.sinty/AGENTS.md` (the old text) and `config.agent.name` (`Sinty`) as the
memory agent id. None of the agent card applied: model, fallback, skills, plugins, `stallSeconds`, service prompts,
agent-scoped memory, and the agent name in `message.agent`.

## Files touched

- `packages/core/src/agent.ts`:
  - `speaker()` resolves members as `session.metadata.agentIds` (strings that are roster agents), else
    `project.agentIds` (also filtered to existing agents);
  - the answering agent is the agent named by the last human message when it is a member, else the project lead when
    the lead is a member, else the first member;
  - no members means `undefined`, and the global AGENTS.md applies as before;
  - sessions without a project work when they carry `metadata.agentIds`;
  - `sendSnapshot()` gets the speaker and fills `persona`.
- `packages/sdk/src/inspect.ts`, `packages/core/src/inspect.ts`: optional `ContextSnapshot.persona`:
  `{ source: "agent" | "global"; agentName? }`.
- `apps/web/src/chat.tsx`:
  - members are computed with the same rule as the core (a non-empty chat list wins, an empty one falls back to the
    project) and also for chats without a project;
  - the reply selector preselects the project lead when it is a member;
  - a warning banner appears when a project chat has no members: the global AGENTS.md answers, add agents on
    «Агенты» or create the chat with participants.
- `plugins/context-inspector/src/page.ts`: a «Персона: …» line under the token bar. It is highlighted as a warning
  when the global AGENTS.md is used because the chat has no agents.
- Tests: `packages/core/src/__tests__/speaker.test.ts` (new, 4 tests), a persona case in
  `plugins/context-inspector/src/page.test.ts`.
- Docs: `docs/spec/context-inspect.md` (`persona`), `CHANGELOG.md`.

## Design decisions

- **One rule for UI and core.** The UI already treated `metadata.agentIds` as the chat's members; the core now does
  the same, so what the header shows is who answers.
- **Lead only when it is a member.** A chat created with chosen participants that exclude the project lead must not be
  answered by the lead. In that case the first chosen participant answers.
- **Existing agents only.** A deleted agent id left in `metadata.agentIds` or in a project is skipped instead of
  producing a speaker with no card.
- **No data migration.** Old sessions already carry `metadata.agentIds`, so they are fixed retroactively from the next
  message.

## Rejected alternatives

- Writing the chat's agents into the empty project when a chat is created. That silently changes the project, and
  other chats in it would suddenly get that agent. The warning plus the existing project editor is explicit.
- Reading an AGENTS.md from the project folder. The core never had that mechanism and the persona lives in the
  roster; adding a second source would make the **Контекст** tab harder to explain.

## Migration notes

None. Projects with members behave as before when chats have no `agentIds` of their own. Chats that do have
`agentIds` now get those agents.

## Known limitations

- The sidebar "+" still creates a project without agents (the warning tells the user what that means).
- Delegated child sessions (`agent.task`) still have no speaker of their own, as before.

## How to test

```sh
pnpm -r --workspace-concurrency=1 run build
cd packages/core && node --test --test-concurrency=1 dist/__tests__/speaker.test.js
cd plugins/context-inspector && node --test "dist/**/*.test.js"
```

Manual: create a project with the sidebar "+", create a chat in it with one agent chosen, send a message. The
**Контекст** tab shows «Персона: AGENTS.md агента «…»», and the first system message is that agent's text.
