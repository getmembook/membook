---
memfile: 2
id: m-f89a
type: gotcha
status: unverified
scope: repo
confidence: 0.9
created: "2026-07-27T21:41:17Z"
anchors:
  - kind: git
    path: packages/core/src/user-store.ts
    commit: b745cc924ee7998d42598c2192da440499077d85
  - kind: git
    path: packages/cli/src/cli.test.ts
    commit: b745cc924ee7998d42598c2192da440499077d85
provenance:
  origin: authored
  author: human
---

Any test that exercises CLI recall, the prompt hook, or the MCP server must set MEMBOOK_HOME to a temp dir: those surfaces attach the user store at ~/.membook/store by default, so a developer's real preferences silently join recall results and break assertions. cli.test.ts does this in beforeEach; copy that pattern in new suites.
