# Visitor login

Closed pages used to hide the body for everyone. A visitor can now sign in on the site itself. Staff still sign in to the harness.

## What changed

Visitors live in the site database, not in the staff table. `visitors` stores email and a scrypt hash. `sessions` stores a random token for 30 days. The cookie is `site_visitor`, HttpOnly, path `/p/site`.

`/p/site/login` registers and signs in when email login is on (the default). A published page with `loginRequired` returns the body only when that cookie is valid. `/p/site/public/<slug>` does the same.

`site.login` turns email, Google, Telegram, Yandex and VK on or off. The flags are booleans in `login_settings`. OAuth client secrets are not stored here; those providers do not have a button that completes a login yet. `site.visitors` lists emails and never the hash. The Вход tab shows the flags and the visitor count.

## Why

The plan keeps two logins: staff in the harness, visitors on the site. Email works without a domain. OAuth needs redirect URLs and secrets, so only the switches are in this slice.

## Test

`plugins/site/src/store.test.ts`: a closed page stays hidden, the same page opens for a session created by `registerVisitor`, a wrong password is refused.
