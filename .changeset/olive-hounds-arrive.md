---
"membook": minor
---

Add the `membook` CLI: `init`, `status`, `verify`, `review`, `remember`,
`book`, `reindex`.

This is the human's surface where the MCP server is the agent's. `review` is
where a person ratifies or rejects what an agent recorded — ratifying marks a
memory verified and re-anchors it to HEAD, because a human reading the code and
confirming the statement is a verification, and the strongest kind available.
`remember` writes `origin: authored, author: human` with `agent` and `model`
structurally absent, the first real use of that provenance branch.

`status` explains each state rather than only counting it, so that "nothing is
recorded" and "things are recorded but have drifted" read as different
sentences. `verify --recheck` refuses to run without a configured model rather
than guessing.
