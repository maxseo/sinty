# site

Pages, posts, categories and templates of one site. Records live in SQLite at `$SINTY_HOME/data/site/site.db`.

The agent writes them with `site.write` (always a draft) and `site.publish`. `site.layout` sets the widget tree: block, row, column, widget. `site.template` inserts a template as one dynamic block, so editing the template updates every page that uses it. The harness lists records on Страницы, Блог and Конструктор. A visitor reads published records at `/p/site/public` and `/p/site/view/<slug>`. A record with `loginRequired` keeps its title and hides the body until visitor login exists.

Templates are not public addresses. A slug is unique among pages, posts and categories; templates have their own slugs.
