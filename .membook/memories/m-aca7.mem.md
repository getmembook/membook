---
memfile: 1
id: m-aca7
type: gotcha
status: unverified
scope: repo
confidence: 0.8
created: "2026-07-27T21:41:04Z"
anchors:
  - kind: git
    path: packages/core/src/user-store.ts
    commit: b745cc924ee7998d42598c2192da440499077d85
  - kind: git
    path: packages/cli/src/cli.test.ts
    commit: b745cc924ee7998d42598c2192da440499077d85
provenance:
  origin: authored
  author: agent
  session: mcp
  agent: claude-code
  model: claude-opus-4-8
---

Any test that exercises CLI recall, the prompt hook, or the MCP server must run with MEMBOOK_HOME pointing at a temp dir: those surfaces attach the user store at ~/.membook/store by default, so a developer's real preferences silently join recall results and break assertions. cli.test.ts does this in beforeEach; copy that pattern in new suites.
