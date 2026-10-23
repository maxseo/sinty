# Child speaker inherit with projectId

## Context
`agent.task` children copy the parent's `projectId`. `speaker()` used to inherit the parent agent only when `!session.projectId`, so project chats with empty `agentIds` resolved children to `models.default` (often a different model than the parent's roster agent).

## Change
Inherit the parent's speaker when the child has no own `metadata.agentIds` **and** the project has no `agentIds`. Own chat members still win; project `agentIds` still win when set.

## Verify
- Unit: speaker child with projectId inherits parent when project empty
- Unit: project agentIds still win over parent inherit
- Manual: child turn in a project chat journals the parent's Flash route, not Pro via `models.default`