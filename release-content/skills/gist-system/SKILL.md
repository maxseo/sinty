---
name: gist-system
description: >
  GIST Content System — advanced SEO Pro module (Dr.Max). Triggers: GIST, избыточность, lockout, utility diversity, анти-дубль, перегретые повторы.
  Load workflow.ru.md for run modes.
---

# GIST Content System

Syntet pack: `seo-pro` · bundle: `content-gist`

## Когда использовать

Запросы про: GIST, избыточность, lockout, utility diversity, анти-дубль, перегретые повторы.

## Обязательный порядок

1. `load_skill_bundle` с `skill_id: "seo-pro"`, bundles: `["entry", "content-gist"]`.
2. Прочитай **references/workflow.ru.md**.
3. Прочитай **references/workflow.ru.md** — режимы, входные данные, QC.
4. Итог — в JSON `reply`: вердикт, % роботности, рекомендации или переписанный текст.

## Файлы

- `prompts/GIST Content Logic Skill-v-1.md`
- `prompts/GIST-1-v1.txt`
- `prompts/GIST-2-v1.txt`
- `prompts/GIST-3-v1.txt`
- `prompts/gist-checklist.md`
- `prompts/gist-content-logic-skill-v2.md`
- `prompts/gist-prompts-pack.md`
- `references/workflow.ru.md`

## Syntet-правила

- Режимы 1–5 из workflow — один skill в контексте, не перезагружать каждый раз.
- Cross-load: `copywriting` → `humanize` для лёгкой полировки после режима 3/4.
- Не путать с базовым SEO-аудитом — это лингвистическая форензика текста.
