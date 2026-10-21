# Public internet for plugins (`ctx.net.public`)

Plugins that browse the web get the public internet through the core, not raw network access. The core owns the
SSRF rules (`packages/core/src/netguard.ts`); the address table is `packages/sdk/src/netaddr.ts`, which ships with the
core and cannot be patched by the agent. Used by `tool-web` (`web.search`, `web.read`, `web.links`,
`web.screenshot`, `web.interact`).

## Permission

```json
"permissions": { "net": ["$PUBLIC"], "browser": true }
```

- `"$PUBLIC"` in `permissions.net` enables `ctx.net.public.fetch`, `check` and (with `browser`) `proxy`. It does not
  open plain `fetch`: that stays limited to the explicit hosts in `permissions.net` ∩ `policy.yaml net.allow`.
- `permissions.browser` lets the plugin start Chromium (see `plugin-manifest.md`). Without it `proxy()` fails with
  `net_denied`.
- A plugin without `"$PUBLIC"` gets `net_denied` from every `ctx.net.public` call.

## API

```ts
const res = await ctx.net.public.fetch(url, { method, headers, body, timeoutMs, maxBytes, maxRedirects });
res.url;          // final address after redirects
await ctx.net.public.check(url);              // resolve and check only
const proxy = await ctx.net.public.proxy();   // { server, username, password } for the browser
```

| Option | Default | Max |
|---|---|---|
| `method` | `GET` | `GET`, `HEAD`, `POST` |
| `timeoutMs` (whole request, redirects included) | 20 000 | 60 000 |
| `maxBytes` (decoded body; larger fails `too_large`) | 5 000 000 | 20 000 000 |
| `maxRedirects` | 5 | 10 |

The core decodes gzip, deflate and br and drops `content-encoding` / `content-length`. `Host`, `Connection`,
`Proxy-*` and similar request headers are set by the core. `Authorization` and `Cookie` are dropped on a cross-origin
redirect; 303 (and 301/302 after POST) turn into GET.

Error codes (as `ToolError.code` in the plugin): `net_blocked` (not public internet), `net_denied` (no permission),
`too_large`, `timeout`, `net_failed` (DNS, TLS, connection, too many redirects), `bad_request`.

## What is refused

For every request and every redirect hop:

1. Only `http:` and `https:`. The WHATWG URL parser first normalises odd IPv4 spellings (`2130706433`, `0x7f.1`,
   `0177.0.0.1`, `127.1`, `0`) to dotted form.
2. Names `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa` are refused before DNS.
3. The host is resolved (`dns.lookup`, all records). If **any** record is not public, the request is refused, so a
   mixed answer cannot slip through.
4. The socket connects to the checked address (a pinned `lookup`), and the core verifies the socket's remote
   address. There is no second DNS lookup between check and connect, so DNS rebinding has no window. TLS still uses
   the host name for SNI and certificate checks.

| Range | Class |
|---|---|
| `0.0.0.0/8` | unspecified |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | private (RFC 1918) |
| `100.64.0.0/10` | shared (CGNAT, RFC 6598) |
| `127.0.0.0/8` | loopback |
| `169.254.0.0/16` | link-local (cloud metadata `169.254.169.254`) |
| `192.0.0.0/24`, `192.88.99.0/24`, `240.0.0.0/4` (incl. `255.255.255.255`) | reserved |
| `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32` | documentation |
| `224.0.0.0/4`, `ff00::/8` | multicast |
| `::`, `::1` | unspecified, loopback |
| `::ffff:a.b.c.d` (mapped), `::a.b.c.d` (compatible), `64:ff9b::a.b.c.d` (NAT64), `2002:a.b.c.d::/48` (6to4) | classified by the embedded IPv4 address |
| `64:ff9b:1::/48` | local NAT64 |
| `fc00::/7` | unique-local |
| `fe80::/10` (zone ids like `%eth0` allowed in the input) | link-local |
| `fec0::/10` | site-local |
| `2001::/32` | Teredo (embeds a client address) |
| `100::/64` | discard |

`198.18.0.0/15` (benchmarking) is **not** refused: "fake-ip" DNS of Clash, sing-box and similar TUN proxies answers
every public name with an address from it, and refusing it would break the web for those users.

## Allowlist (`allowPrivate`)

The human may let named private services through, for example a local SearXNG or a NAS:

```yaml
plugins:
  config:
    tool-web:
      allowPrivate: "127.0.0.1:8888, nas.lan"
```

- A string (commas, spaces, `;` or new lines between entries) or a list. An entry is `host`, `host:port`,
  `[v6]:port` or a bare IPv6 address. Entries match the URL host or a resolved address; with a port, only that port.
- The core reads it from `config.yaml` (`plugins.config.<plugin>.allowPrivate`) on every request, never from the
  manifest `config` (the agent can patch that) and never from the plugin's message. Settings → **Веб** edits it; the
  change applies at once, the plugin is not asked.
- Default: empty.

## Browser traffic

`proxy()` starts (once per plugin process) an HTTP proxy on `127.0.0.1:<random port>` with a random Basic credential.

- `CONNECT host:port` and absolute-URI `http://` requests are resolved and checked exactly like `fetch` and then
  connected to the checked address. A refused target gets `403`; a missing or wrong credential gets `407`.
- The proxy closes with the plugin process.
- `tool-web` launches Chromium with this proxy. Playwright adds `<-loopback>` to the bypass list, so `localhost` and
  `127.0.0.1` are proxied (and refused) too. WebRTC may not send UDP around the proxy
  (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`), QUIC is off, downloads and service workers are
  blocked.
- Before each navigation the plugin calls `check()` for a readable error, and after each action it refuses a page
  that left `http(s)` (`file:`, `data:`, …).

## Known limits

- `permissions.browser` implies `--allow-child-process`. The Node permission model cannot narrow that, so a plugin
  with it could start other programs. That is why `tool-web` is the only bundled plugin with it, why a patch that
  changes `permissions` is flagged (`permissionsChanged`), and why applying a patch needs a human.
- Non-HTTP protocols are out of scope: the guard covers `ctx.net.public` and the browser proxy only.
- The allowlist is host- and address-based; a name in it may resolve to any address.
