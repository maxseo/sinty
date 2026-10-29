# Site form

A page can take a request. Sending the letter or the Telegram message is not this plugin's job.

## What changed

The widget type `form` renders name, email, phone, telegram and message. `props.fields` picks a subset. `POST /p/site/form` writes a row in `requests`: the page slug, those fields, status `pending`.

`site.requests` lists them. `site.request` sets `sent` after the notice went out, or `pending` if it still has to. The Заявки tab shows the same list. Passwords and connector tokens are not in the row.

## Why

Mail and Telegram already belong to harness connectors. The form only has to keep where the client can be reached. The agent reads that and sends when a connector is enabled. A site with no connector still keeps the request.

## Test

`plugins/site/src/store.test.ts` stores a request with an email and a Telegram handle, then marks it sent.
