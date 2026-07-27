---
memfile: 1
id: m-6dd5
type: gotcha
status: verified
scope: repo
confidence: 0.9
created: "2026-07-21T16:42:00Z"
verified: "2026-07-24T08:00:00Z"
anchors:
  - kind: git
    path: packages/core/src/index/sqlite.ts
    symbol: openIndex
    line_range: [18, 46]
    commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
provenance:
  origin: distilled
  session: sess-01H8X4M2
  agent: claude-code
  model: claude-opus-4-8
  source_hash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
---

`better-sqlite3` must be loaded after the process sets `PRAGMA journal_mode=WAL`,
or concurrent MCP sessions on the same repo deadlock on first write.

Symptom is a silent hang in `recall`, not an error — the second stdio server
blocks forever acquiring the write lock.
