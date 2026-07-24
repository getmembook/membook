---
memfile: 1
id: m-6f7c
type: gotcha
status: unverified
scope: repo
confidence: 1
created: "2026-07-24T14:22:31Z"
anchors:
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

`npm view` 404s for minutes after a first publish while the package exists fine; use `npm owner ls <pkg>` to confirm, since it reads a different path. Also `--tag alpha` does not stop npm setting `latest` — a package's first publish always takes `latest` whatever tag you pass.
