---
memfile: 1
id: m-51bb
type: decision
status: verified
scope: repo
confidence: 0.95
created: "2026-07-20T09:14:00Z"
verified: "2026-07-24T08:00:00Z"
anchors:
  - kind: git
    path: packages/core/src/index/sqlite.ts
    commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
  - kind: git
    path: .gitignore
    commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
provenance:
  session: sess-01H8X2K9
  agent: claude-code
  model: claude-opus-4-8
  source_hash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
---

Store SQLite index under `.membook/index/` and treat it as disposable cache.

Canonical memory state is the markdown files in `.membook/memories/`; the index
is rebuilt bit-perfect by `membook reindex`, so it is gitignored and may be
deleted at any time without data loss.
