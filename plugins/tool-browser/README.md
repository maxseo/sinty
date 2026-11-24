# Browser

Persistent headed Chromium for ordinary owner chat. Canonical tool: browser.control. Browser owns its Playwright backend; tool-web remains HTTP/search/read/download with deprecated stateless compatibility tools. The trusted core binds Browser calls to the actual scheduler agent/project; direct plugin RPC cannot manufacture ownership.

Say in an existing agent chat: «Открой https://example.com, прочитай страницу и покажи скриншот». Browser calls prepare itself, keeps the agent/project profile, and never uses personal Chrome data. Panel: #/browser-pilot (pause, resume, close). Old browser.pilot history aliases to browser.control. Manual takeover is never automatically resumed. A transient snapshot timeout permits one read retry; an unknown mutation result remains quarantined and requires closing only that owned browser before a new prepare.

Public HTTP(S) passes the existing authenticated DNS-pinned broker. Private addresses, embedded credentials, file/data/javascript URLs, popups, WebSockets and service workers remain blocked. This is not OS/container isolation, human stealth, an anti-bot bypass, or a guarantee that arbitrary clicks cannot submit forms. Exact existing action approvals remain; chat-selected workspace files only; downloads stay in project _out. No new global/default-on grant: migration adds this plugin only to agents that already had effective WebTools browser access, unless excluded.

No browser launches at plugin startup. Real external end-to-end acceptance is user-initiated ordinary chat, not a shell browser probe.
