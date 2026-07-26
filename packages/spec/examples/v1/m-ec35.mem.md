---
memfile: 1
id: m-ec35
type: deadend
status: stale
scope: repo
confidence: 0.8
created: "2026-07-18T15:20:00Z"
anchors:
  - kind: git
    path: packages/core/src/git/log.ts
    commit: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b
provenance:
  origin: authored
  author: agent
  session: sess-01H8V2C1
  agent: claude-code
  model: claude-opus-4-8
---

Do not use `isomorphic-git` for rename detection — `log --follow` has no equivalent.

Rename tracking is required for the stale-vs-invalidated distinction, and the
pure-JS implementation cannot reproduce git's similarity heuristics. Shell out
to the plain `git` CLI via execa instead.
