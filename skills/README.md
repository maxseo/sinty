# Skills

Agent Skills format: one folder per skill with `SKILL.md` (YAML front matter `name`, `description`, then instructions) and optional `scripts/`, `references/`, `assets/`.

The `skills` context plugin lists skill names and descriptions in the prompt and loads the full `SKILL.md` only when the agent opens it. The agent may create and edit skills in `$SINTY_HOME/skills/` directly.
