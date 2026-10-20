# memory-obsidian

Read-only memory provider that searches a Markdown / Obsidian vault. Disabled by default.

- Builds its own index (`$DATA/index.json`: notes split by headings, term counts) and refreshes it by mtime at most
  every `rescanSeconds` when a recall arrives. The vault itself is never written.
- Ranking: BM25 over heading chunks, title and headings weighted ×3.
- Results reach the prompt as **untrusted** records (`[memory-obsidian] path.md: …`) through the core memory router,
  with secrets redacted and a recall token budget.

## Enable

```yaml
plugins:
  enabled: [..., memory-obsidian]
  config:
    memory-obsidian:
      vault: /home/me/Obsidian/Main     # absolute path; this is also the read grant ($CONFIG.vault)
memory:
  recall:
    auto: true        # recall with each user message; or let a processor plan recall
```

The read permission comes from `$CONFIG.vault`: only the value you put in `config.yaml` is granted, not a default in
the plugin manifest, so a patched plugin cannot widen its own access.

## Limits

- `.md` files only, skips dot-folders, `.obsidian`, `.trash`, files over `maxFileBytes` (512 KB), at most `maxFiles` (5000).
- Lexical search only (no embeddings yet); no attachments, no Dataview.
