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
    commit: c445ac3e8b1dbbf1f3c29045945153919c844dfa
provenance:
  origin: authored
  author: agent
  session: sess-release
  agent: claude-code
  model: claude-opus-4-8
---

`npm view` 404s for minutes after a first publish while the package exists fine; use `npm owner ls <pkg>` to confirm, since it reads a different path. Also `--tag alpha` does not stop npm setting `latest` — a package's first publish always takes `latest` whatever tag you pass.
