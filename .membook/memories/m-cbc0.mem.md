---
memfile: 1
id: m-cbc0
type: gotcha
status: unverified
scope: repo
confidence: 1
created: "2026-07-24T14:22:31Z"
anchors:
  - kind: git
    path: packages/cli/package.json
    commit: ba39c02315b4848cd381044a39b11321d1949c97
  - kind: git
    path: docs/releasing.md
    commit: ba39c02315b4848cd381044a39b11321d1949c97
provenance:
  origin: authored
  author: agent
  session: sess-release
  agent: claude-code
  model: claude-opus-4-8
---

Publish with pnpm, never npm. npm leaves pnpm's `workspace:*` protocol unresolved in the packed tarball, so the install fails and node_modules/.bin/membook is never created — the symptom is `npx membook` doing nothing, not any error mentioning workspaces. The only check that catches it is installing the tarball and confirming the binary linked; npm's warning about `bin` is misleading and fires even when bin is fine.
