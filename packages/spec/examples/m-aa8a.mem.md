---
memfile: 2
id: m-aa8a
type: map
status: unverified
scope: repo
confidence: 0.85
created: "2026-07-25T10:12:00Z"
anchors:
  - kind: xgit
    repo: platform-gateway
    path: config/limits.yaml
    commit: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b
  - kind: git
    path: src/clients/gateway.ts
    commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
provenance:
  origin: authored
  author: agent
  session: sess-01H8ZQ7F
  agent: claude-code
  model: claude-opus-4-8
---

The gateway's rate-limit config is the contract this service consumes:
`config/limits.yaml` in `platform-gateway` defines the per-tenant buckets.

Anchored cross-repo so a limits change flips this stale in the consumer
BEFORE an agent writes code against the old shape (contract-watch).
