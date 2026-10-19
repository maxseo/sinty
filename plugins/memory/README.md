# memory

Facts live in `$DATA/memory.db` (SQLite). Profile is inserted into every turn. Journal and notes are returned by `memory.recall`. A note expires after 14 days. The profile holds at most 40 facts.

`memory.write` takes one sentence. The same normalized text updates the existing row. A newer fact about the user replaces older copies. A fact about how to work stays on the agent when a user-scoped copy repeats it.

`memory.recall` does not search the profile. It merges full-text rank with a vector rank when the caller passes an embedding of the configured width.
