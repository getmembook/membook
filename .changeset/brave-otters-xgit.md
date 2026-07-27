---
"@membook/spec": minor
"@membook/core": minor
"membook": minor
"@membook/mcp": minor
---

Memfile v2: the `xgit` cross-repo anchor kind — and the version machinery keeping its promise.

The spec gains `xgit` anchors (`kind: xgit, repo: <workspace member>, path, commit` — the same claim, pinned into a different repository), which is the breaking change the memfile version field existed for: `MEMFILE_SPEC_VERSION` is now 2. v1 files stay readable forever — they parse by widening into the current shape under a frozen v1 schema, byte-frozen v1 goldens guard the promise external implementers rely on, and `membook migrate` brings a store forward as one reviewable diff (this repo's own 12 memories crossed in exactly that way). The verify pass declines to check xgit-anchored memories rather than reporting partial coverage as a verdict — workspace verification is next. `scope: user` is reserved (rejected with its own message) until the anchorless user store lands.
