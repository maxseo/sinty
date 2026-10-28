# Staff accounts

## What changed

`packages/core/src/accounts.ts` stores people, roles and grants in `accounts.db`. The first account is the system superadmin and cannot be removed, disabled or demoted while it is the last one. A role gets checkboxes per panel section (`nav:chats`, `nav:projects`, `nav:plugins`, `nav:skills`, `nav:mcp`) and per `project:<id>`. Missing grant means no access. The machine token (`sinty web`, `Authorization: Bearer`) is unchanged and bypasses grants.

`POST /v1/auth/login`, `/forgot`, `/reset`, `/setup`. Forgot does not send mail and does not say whether the email exists. A superadmin copies a one-hour link from the employee row. `sinty user password <email> <new>` is the operator fallback.

The Web UI Settings section «Сотрудники» has people, roles and the rights tables. The sign-in form accepts email and password as well as the machine token.

## Why

One install has to serve an admin, later a company, and a public site. Hiding a sidebar button is not enough: the API checks the same grants.

## Not in this change

Mail delivery, guests of a public site, several people in one chat, and per-person exceptions on top of a role.

## Revert

Remove `Accounts` from `Sinty`, the `/v1/auth` and `/v1/accounts` routes, and the staff page. Delete `accounts.db`.
