# Chat attachments -> project `_inbox`

- Date: 2026-10-26
- Area: `packages/core` blobs + agent.send, project workspace
- Plan step: close gap after #25 - user chat uploads belong in the project folder
- Commits: this commit
- PR: (opened with this branch)

## What and why

Max attached a file in a project chat and it did not appear under the project directory. He expected the #25 project chroot / documents-go-into-the-project behavior to cover chat attachments too.

Diagnosis: #25 only chrooted agent tools (`fs.*`, `shell.run`, screenshots / later `web.fetch_file`). Chat attach has always been `POST /v1/blobs` -> `$SINTY_HOME/data/blobs/<sha256>` (content-addressed), then a `BlobRef` on `message.user`. The system prompt already said `_inbox holds uploads`, and `ensureProjectDirs` creates `_inbox`, but nothing ever wrote chat uploads there. Live evidence: today's PDF only under `data/blobs`; older `_inbox` docs were agent/tool copies, not UI attach.

## Design decisions

- Materialize on `agent.send` when the session has `projectId` (all channels), not on `/v1/blobs` (upload happens before the message and has no session).
- Keep the blob store for `renderAttachment` / model input.
- Filename sanitization + `name-2.ext` on collision; identical bytes reuse the existing file.
- No projectId -> no `_inbox` write (global chats stay blob-only).

## Known limitations

- Does not backfill older blob-only attachments into `_inbox`.
- Attach-then-discard (upload blob without sending) still leaves only a blob.
- Duplicate attach of different bytes with the same name gets a numeric suffix, not overwrite.
