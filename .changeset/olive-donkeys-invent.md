---
"@membook/spec": minor
"@membook/core": minor
---

Initial pre-release of the Memfile standard and the storage engine.

`@membook/spec` defines the format: Zod schema, anchor grammar, deterministic
serialization, and a validator that fails loudly on read and on write.
Provenance is discriminated so that every field's presence is meaningful — a
`source_hash` appears only when a real artifact stands behind it, and a
human-authored memory cannot express an `agent` or `model` it never had.

`@membook/core` implements storage: file CRUD, a derived SQLite + FTS5 index
with pinned assumptions, and `reindex`. Files are the truth; the database is a
cache, rebuilt deterministically from them.

Neither package is published yet.
