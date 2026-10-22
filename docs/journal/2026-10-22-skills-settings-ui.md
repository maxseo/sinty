# Skills settings: list, viewer, import

- Date: 2026-10-22
- Area: plugins/skills, apps/web
- Plan step: skills loader follow-up
- Commits: this commit

## What and why
Settings → Навыки was only `catalogLimit`. The folder of skills was invisible, so adding one meant writing files by hand. The page now lists installed skills, opens one in a dialog, and adds a skill by paste, file import, or a short form.

## Files touched
`plugins/skills/src/skills.ts` (`importSkill`), `plugins/skills/src/index.ts` (`GET /item`, `GET /file`, `POST /import`), `apps/web/src/skills-pane.tsx`, `apps/web/src/supervisor-ui.tsx`, `apps/web/src/style.css`.

## Design decisions
The dialog shows the skill text and the file list. It does not edit. Import goes through the plugin, which already owns `$SKILLS`, instead of a new core route. The catalog limit stays on the list tab and still needs a restart to change the prompt.

## Rejected alternatives
A markdown renderer. Plain text matches the rest of the settings and does not pull in a new library.

## Migration notes
None. Existing skill folders show up as they are.

## Known limitations
The prompt catalog updates after `sinty web` restarts. Paste import accepts text files only. Zip and folder install copy up to 200 files and skip `node_modules` and dot folders. There is no delete button. `sinty skills add` and the folder field read the disk from the core, not from the plugin process.

## How to test
`pnpm --filter @sinty/plugin-skills test`. In the UI, open Навыки, add a skill from the form, and open its card.
