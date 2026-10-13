# Contributing

Thanks for helping. Sinty is spec-first: contracts in `docs/spec/` and `packages/sdk` come before code.

## Where your change belongs

1. **A new tool, provider, channel, memory backend or UI** — a plugin in `plugins/<name>/`. This is almost always the right answer.
2. **A skill** — a folder in `skills/<name>/` with `SKILL.md` (Agent Skills format).
3. **The core** — only for the turn loop, tool registry, policy gate, journal, plugin host, API or supervisor. Open an issue first and explain why it cannot be a plugin.

## Workflow

```sh
pnpm install
pnpm typecheck
pnpm test
```

- One logical change per PR. Spec and code change together.
- Conventional commits: `feat(plugin-telegram): ...`, `fix(core): ...`, `docs(spec): ...`.
- New plugins ship with tests and a `README.md` describing tools, permissions and config.

## Plugin checklist

- [ ] `sinty.plugin.json` validates against `schemas/plugin-manifest.schema.json`
- [ ] Minimal permissions: only the paths, hosts and secrets the plugin needs
- [ ] Every tool has a description, an input schema, `sideEffects`, `idempotent` and a `docs` file
- [ ] Errors are thrown as `ToolError` with a code and a hint the supervisor can show
- [ ] Tests run offline
