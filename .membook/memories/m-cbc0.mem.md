---
memfile: 1
id: m-cbc0
type: gotcha
status: verified
scope: repo
confidence: 1
created: "2026-07-24T14:22:31Z"
verified: "2026-07-25T00:25:40Z"
anchors:
  - kind: git
    path: packages/cli/package.json
    commit: e6f24aaa8feeeec814b5b16b1b5b1346c5e26c38
  - kind: git
    path: docs/releasing.md
    commit: e6f24aaa8feeeec814b5b16b1b5b1346c5e26c38
provenance:
  origin: authored
  author: agent
  session: sess-release
  agent: claude-code
  model: claude-opus-4-8
---

Publish with pnpm, never npm. npm leaves pnpm's `workspace:*` protocol unresolved in the packed tarball, so the install fails and node_modules/.bin/membook is never created — the symptom is `npx membook` doing nothing, not any error mentioning workspaces. The only check that catches it is installing the tarball and confirming the binary linked; npm's warning about `bin` is misleading and fires even when bin is fine.
