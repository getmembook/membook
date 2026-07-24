---
memfile: 1
id: m-d4a3
type: map
status: verified
scope: repo
confidence: 0.85
created: "2026-07-22T13:30:00Z"
verified: "2026-07-24T08:00:00Z"
anchors:
  - kind: git
    path: packages/core/src/verify/pass.ts
    symbol: verifyPass
    commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
  - kind: git
    path: packages/core/src/git/diff.ts
    commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
provenance:
  session: sess-01H8XB4T
  agent: claude-code
  model: claude-opus-4-8
  source_hash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
---

Verification entry point is `verifyPass()` in `packages/core/src/verify/pass.ts`.

It fans out: `git diff --name-status <anchor.commit>..HEAD` per distinct commit,
intersects changed paths with anchor paths, and routes untouched anchors to a
free re-verify and touched anchors to a single targeted LLM re-check.
