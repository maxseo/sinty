# site

Pages, posts, categories and templates of one site. Records live in SQLite at `$SINTY_HOME/data/site/site.db`.

The agent writes them with `site.write` (always a draft) and `site.publish`. The harness shows lists on the Страницы and Блог tabs. A visitor reads published records at `/p/site/public` and one record at `/p/site/public/<slug>`; `/p/site/view/<slug>` is the plain local page. A record with `loginRequired` keeps its title and hides the body until visitor login exists.

Templates are not public. Slugs are unique inside one kind.
