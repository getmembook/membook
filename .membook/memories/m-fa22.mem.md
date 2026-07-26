---
memfile: 1
id: m-fa22
type: gotcha
status: unverified
scope: repo
confidence: 0.8
created: "2026-07-26T19:58:38Z"
anchors:
  - kind: git
    path: packages/core/src/workspace.ts
    commit: 44e12f13ce66421973fceaf62029273b6028edda
  - kind: git
    path: packages/core/src/workspace.test.ts
    commit: 44e12f13ce66421973fceaf62029273b6028edda
  - kind: git
    path: .github/workflows/codeql.yml
    commit: 44e12f13ce66421973fceaf62029273b6028edda
provenance:
  origin: authored
  author: agent
  session: mcp
  agent: claude-code
  model: claude-opus-4-8
---

CI blocks on CodeQL js/polynomial-redos: regexes like /\/+$/ or ambiguous host patterns over library input fail the gate even for local-only strings — canonicalRemote uses linear string walks (trimSlashes, scpLikeHost) instead, and new string-normalization code should too. The advisory Windows build also runs the full test suite, so test assertions must build expected paths with join(), never POSIX literals.
