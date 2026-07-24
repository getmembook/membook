---
memfile: 1
id: m-bf6b
type: decision
status: verified
scope: repo
confidence: 1
created: "2026-07-24T15:09:04Z"
verified: "2026-07-24T15:09:10Z"
anchors:
  - kind: git
    path: packages/spec/src/schema.ts
    symbol: memorySchema
    commit: b5a07e02ee30f46ab27239d30ffcf13e2237fc36
  - kind: git
    path: docs/design/v0.2-workspaces.md
    commit: b5a07e02ee30f46ab27239d30ffcf13e2237fc36
provenance:
  origin: authored
  author: agent
  session: sess-v02-design
  agent: claude-code
  model: claude-opus-4-8
---

`scope` becomes a discriminated union in v0.2: user-scope memories forbid anchors entirely, and the verification vocabulary (`status`, `verified`) is absent from their shape rather than perpetually unverified. An anchor is what makes a memory a checkable claim about the world; a user preference is testimony about the human, so verification is a category error against it, not a pending obligation. If you have a file to point at, it is repo knowledge wearing the wrong scope.
