# MCP stdio adapter checkpoint

The existing `mcp-stdio` runtime supports two explicit framings:

- `plugins.config.<plugin>.stdioTransport: content-length` — default, preserves existing Sinty servers.
- `plugins.config.<plugin>.stdioTransport: ndjson` — newline-delimited JSON-RPC, required by the installed CUA Driver.

No transport is guessed, and a tool action is never replayed to try another transport.
`stdioRequestTimeoutMs` is optional (integer 10–300000, default 120000). Startup requests are bounded to at most 10000 ms each; the host also retains its existing plugin readiness timeout.

Incoming/outgoing messages are capped at 16 MiB, Content-Length headers at 8 KiB, pending requests at 128, and catalog pagination at 32 continuations / 4096 tools. Invalid frames terminate the connection. Server stderr is drained but its content is not forwarded into errors or model prompts.

Tool schemas are converted using the already-installed Zod JSON Schema converter. Required fields and constraints reach the normal runner validation and model tool-schema path. Unsupported schemas (including external refs) fail registration instead of falling back to unrestricted arguments. All imported MCP tools remain `external`, non-idempotent; no permissions, roster entries, or driver startup grants are added.

Cancellation sends `notifications/cancelled`, rejects the waiting caller promptly, and ignores late replies. The server must cooperate: this does not prove that a browser/native operation has stopped. Closing/unloading rejects outstanding requests and terminates the direct MCP child.

Text-only results retain the legacy string return. Mixed image/text and structured results preserve the result envelope at the adapter boundary.

## Inline tool images (source checkpoint, not deployed)

The existing SDK already has `BlobRef`, `tool.call.completed.blobs`, and `ChatMessage.images`; no SDK/event/wire protocol extension was needed. For MCP-stdio results, the host now stores standard inline PNG/JPEG image blocks in the existing SHA256 blob store before journaling. The event contains artifact refs, not inline image bytes; repetitions of a known inline payload in structured metadata/text are also replaced by its ref. This is **not** a general secret/redaction system for arbitrary server text. URI resources, image URLs and server-provided file paths are never resolved by this path.

Limits: at most 4 images, 4,000,000 bytes per image, 8,000,000 bytes per result/context replay; each dimension <=8192, area <=16,000,000 pixels. Base64 must be canonical, MIME must match the PNG/JPEG header. These are bounded header/dimension checks, not a complete image decoder or malware scanner. Invalid batches fail the tool result with `invalid_mcp_image` before any image is stored. Storage failures may leave an unreferenced artifact.

Replay verifies hash, file type, bounded size and header, ignores missing/modified/symlinked artifact files, and sends up to the most recent four image observations using the existing image primitive. Every result in a parallel tool batch precedes the image message. Observation order is labeled with callId/blob and remains untrusted tool output; packaging it as a user-role multimodal message does not turn page text into user authorization. Inspector snapshots already omit inline image bytes. The trusted core blob directory is assumed, not a new arbitrary-filesystem sandbox.

OpenAI-compatible Chat Completions already supported user image blocks; Anthropic and OpenAI Responses now do too. Offline tests verify actual image bytes reach the core's provider IPC and become real `image_url` / `image` / `input_image` blocks. No paid provider call or actual screenshot was used; a vision-capable model is still required. The subsequent staged pilot checkpoint replaces base64-as-text accounting with an explicit conservative 32,768-token reserve per image plus text/tool overhead. Text-only estimates are unchanged. This is not provider billing or a universal tokenizer: OpenAI tile/patch, Anthropic resizing and other models differ. Actual usage ratio feedback still applies. Fallbacks preserve image bytes or explicitly reject a too-small window; no text conversion is used.

## Staged browser-only pilot (native adapter deliberately not enabled)

There is now a minimal core broker (browser-pilot.ts), owner API and owner-only UI route #/browser-pilot under Settings. The UI uses the existing bearer/account helper; only the machine owner or signed-in superadmin may control it. Control requests check current Origin/Sec-Fetch-Site and require an Authorization header (not query tokens). An owner selects an actual roster agent belonging to an actual project. The server creates a dedicated session and canonical workspace; grant lifetime is 20 minutes.

The owner-only send endpoint calls Agent.sendPilot. It validates roster membership, server session/project/workspace and captures an immutable execution in the scheduler before launch. Optional CallCtx.execution comes only from that running turn, never speaker/session metadata/model args. Pilot speaker is pinned to the captured roster UUID. Plugin bridge has no sendPilot op; normal send is refused on leased sessions. Pilot model catalogs AND dispatch allow only browser.pilot and ask_human: shell, delegation, raw MCP, Web Tools and every desktop/script/clipboard alternative are excluded from this dedicated lane. Normal sessions and roster defaults are unchanged. Within this owner-granted fixture lane only, policy ask is journal-approved by the explicit owner grant; explicit policy deny remains deny. No message/send/public-site permission is granted.

The strict model interface accepts prepare/state/goto/ref-click/type/select/scroll/attach/download only. Goto has no URL argument: only the server-owned local fixture. All native sessions/targets/tabs and stable owner+agent profile names are core-owned. Prepare accepts only isolated_named/allow_launch; no existing_profile/PID/window. Pointer is scroll-only. Uploads must be explicitly owner-selected project-relative files; canonical paths, no traversal/ADS/UNC, no symlink/junction/hardlink, regular <=16MB, bounded staging copy. Downloads use reserved project _out/browser-pilot paths. This is not OS-level confinement against hostile same-user processes racing filesystem directory replacement; no stronger sandbox guarantee is claimed.

Owner pause/takeover blocks new agent calls immediately. In-flight work remains pausing until it actually returns; only then manual. Resume requires idle manual state. Native errors/abort/30-second deadline quarantine unknown work instead of pretending it stopped. Release waits at most five seconds for trusted adapter closure confirmation; locks are removed only after confirmed closure with no pending work. Failed/unclean restart locks are never auto-removed; explicit verified recovery is still needed. Named profile mapping is deterministic across clean restarts; authority/leases are not revived from chat metadata or disk.

No production native adapter is installed/enabled. BrowserPilotDriver is an internal normalized interface, not a guessed CUA output schema. Default ready=false; owner grant API fails with driver_contract_unverified before creating a session or launching anything. Tests use only mocks. The source UI truthfully shows blocked state, not a working browser. CUA native output/consent and headed Windows handoff need validation on a fresh isolated fixture before implementing/enabling that adapter through the existing MCP transport. No new browser stack or plugin was introduced.

Required parent-controlled fixture evidence: browser_prepare with core-generated isolated_named profile/session and normal native consent; verified result-to-owned-target/tab normalization; exact state/image block shape; navigation only to the local controlled form; synthetic fill/upload without submission; manual pause waits for in-flight completion; end_session and dedicated-worker/browser closure proof; named-profile persistence after clean restart. Do this using the proper desktop/manual mechanism, never Shell browser actions. Until then do not enable native rights or restart the live app.

The public local fixture has synthetic fields, a disabled submit button, CSP form-action/connect-src none and a fixed synthetic download. Click/type/file selection may generally transmit data; no button blacklist or generic semantic-submit guarantee is claimed. External authenticated websites and remote desktop are outside this pilot.

The local checkpoint was compiled into `packages/core/.mcp-adapter-checkpoint-20261118`; the running `dist` and live configuration were not replaced. Real CUA verification used only `initialize`, `notifications/initialized`, `tools/list`, then process shutdown. No `tools/call`, browser launch, desktop observation, profile attachment, or external generation was requested.
