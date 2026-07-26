---
memfile: 2
id: m-6f7c
type: gotcha
status: verified
scope: repo
confidence: 1
created: "2026-07-24T14:22:31Z"
verified: "2026-07-25T00:22:55Z"
anchors:
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

`npm view` 404s for minutes after a first publish while the package exists fine; use `npm owner ls <pkg>` to confirm, since it reads a different path. Also `--tag alpha` does not stop npm setting `latest` — a package's first publish always takes `latest` whatever tag you pass.
