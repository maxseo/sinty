# Site plugin, first slice

The site lives in the harness. This slice is the database and the records. The constructor, visitor login, forms and the public frontend are not in it.

## What changed

`plugins/site` stores pages, posts, categories and templates in `$SINTY_HOME/data/site/site.db`. A record has a slug, a plain body, draft or published, a flag that the page needs a visitor login, an optional category, and SEO fields (title, description, image, noindex).

`site.write` creates a draft or updates a record. `site.publish` shows or hides it. `site.list` and `site.read` see drafts. Slugs are unique among public records; templates have their own slugs.

The harness sidebar gains Страницы and Блог. They list records. A visitor gets published records at `/p/site/public` and `/p/site/public/<slug>`, and a plain page at `/p/site/view/<slug>`. A closed page keeps its title and returns an empty body.

`site.*` is allow in the default policy, same as the board: the agent edits the site without a prompt on every record. Publishing still follows the task, because a draft is not visible until `site.publish`.

## Why

The agreed plan starts with the records the agent and the future constructor share, before widgets and a separate website.

## Test

`plugins/site/src/store.test.ts`: a draft is hidden, publishing shows the body, a closed page hides it, a repeated slug is refused.
