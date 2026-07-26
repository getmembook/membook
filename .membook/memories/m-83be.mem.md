---
memfile: 2
id: m-83be
type: decision
status: verified
scope: repo
confidence: 1
created: "2026-07-24T00:54:10Z"
verified: "2026-07-25T00:25:07Z"
anchors:
  - kind: git
    path: packages/spec/src/schema.ts
    symbol: CANONICAL_TIMESTAMP_RE
    commit: e6f24aaa8feeeec814b5b16b1b5b1346c5e26c38
  - kind: git
    path: packages/spec/src/serialize.ts
    symbol: TIMESTAMP_KEYS
    commit: e6f24aaa8feeeec814b5b16b1b5b1346c5e26c38
provenance:
  origin: authored
  author: agent
  session: sess-founding
  agent: claude-code
  model: claude-opus-4-8
---

Timestamps serialize double-quoted, in canonical UTC second precision, by explicit
serializer rule.

js-yaml (via gray-matter) applies the YAML 1.1 schema, which silently coerces an
unquoted ISO timestamp into a Date — an invisible mutation that breaks byte-exact
round-trips and pollutes diffs. The rule is stated explicitly rather than left to
the emitter's quoting heuristics, because those heuristics are what let the
coercion through. Offsets are normalized, not rejected, so a memory written in
Kochi and re-verified in London never produces a timezone-representation diff.
