---
memfile: 1
id: m-be36
type: decision
status: stale
scope: repo
confidence: 1
created: "2026-07-24T00:54:10Z"
verified: "2026-07-24T15:09:10Z"
anchors:
  - kind: git
    path: packages/spec/src/schema.ts
    symbol: gitAnchorSchema
    commit: d57ca04d919939982aaa76af11d839a66a35f8a5
  - kind: git
    path: packages/spec/src/serialize.ts
    symbol: ANCHOR_KEY_ORDER
    commit: d57ca04d919939982aaa76af11d839a66a35f8a5
provenance:
  origin: authored
  author: agent
  session: sess-founding
  agent: claude-code
  model: claude-opus-4-8
---

Anchor `kind` is always serialized explicitly, and leads every anchor map.

Zod discriminates before defaults apply, so an omitted discriminator is a hard
reject rather than a fallback to `git` — and papering over that with a preprocess
step would cost more than the one line it saves. Emitting `kind` makes v0.2's
lockfile-hash and API-contract anchors purely additive: any reader written against
v1 files already handles the discriminator. Leading with it makes anchor diffs
scannable in PR review.
