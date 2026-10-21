# skills

Skills of Sinty: the skills catalog in the prompt and the tools `skill.read`, `skill.files`, `skill.read_file`,
`skill.write_file`, `skill.edit`, `skill.write`. They were part of the core until plan step 7; tool names,
descriptions, input schemas, error codes and hints are unchanged, so policies (`"skill.*": allow` in policy.yaml),
approvals, the supervisor, `agent.task`'s default tools and old journals keep working. The plugin is on by default;
turn it off with `plugins.disabled: [skills]` in config.yaml or by unticking it in Settings, or for one roster agent
by unticking it on the agent card (`excludedPlugins`).

A skill is a folder `skills/<name>/` with a `SKILL.md` (or `skill.md`) and any scripts or extra instructions next to
it. Names are letters, digits, `-` and `_`. Paths always stay inside the skill folder.

Each tool has its own section below; the supervisor quotes only the section of the tool that failed.

## skill.read

`skill.read {name}`: the skill's SKILL.md (up to 24000 characters, `truncated: true` beyond). Use a name from the
skills list in the prompt; a skill past the catalog limit is still readable by name. Fails with `not_found` when there
is no such skill or the name has other characters.

## skill.files

`skill.files {name}`: the files of one skill folder (up to 200, dot files and node_modules skipped). `not_found` when
the skill does not exist.

## skill.read_file

`skill.read_file {name, path}`: one text file of a skill, path relative to the skill folder (for example
`scripts/boil.js`). `not_found` when the file is missing, binary or outside the skill folder.

## skill.write_file

`skill.write_file {name, path, text}`: create or replace one text file of a skill (up to 100000 characters). Creates
the folders on the way. `invalid_args` for an empty text, a binary text or a path outside the skill folder.

## skill.edit

`skill.edit {name, path, old, replacement}`: replace one fragment that appears exactly once. Read the file first and
copy the exact text. `invalid_args` when the fragment is missing or appears more than once: include more lines.

## skill.write

`skill.write {name, text}`: create or replace `skills/<name>/SKILL.md`. Put `description:` in the frontmatter (or a
`# ` heading) so the catalog lists it from the next model step.

## Catalog

The catalog is a system section (`ctx.systemSection`, kind `skills`): it sits right after the system prompt, in the
static zone of the prompt, so the provider's prompt cache keeps it. It lists the skills the speaking agent has
(the ticked ones on its card; all of them outside projects), sorted by name, at most `catalogLimit`. It changes only
when a skill is added, removed or gets a new description, or when the agent card changes.

The agent card's skills tab reads `GET /p/skills/list` (the core still answers `GET /v1/roster/skills` with the same
list; with the plugin off it is empty and says `disabled: true`).

## Settings

Section «Навыки»: `catalogLimit` (default 60, 1 to 500), the number of skills listed in the prompt. Applies after the
plugin restarts.
