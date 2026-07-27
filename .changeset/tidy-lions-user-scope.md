---
"@membook/spec": minor
"@membook/core": minor
"membook": minor
"@membook/mcp": minor
---

The scope discrimination and the user store: memories that follow the human.

The spec's reserved slot fills in (v0.2 §8, ruled): `scope` is now a discriminated union. Repo and team memories keep the full lifecycle — anchors required, status, verification. A `user` memory FORBIDS anchors and has no `status` or `verified` in its shape at all: a preference is testimony about the human, not a checkable claim about the world, and verification is a category error against it, not a pending obligation. If you have a file to point at, it is not a preference.

User memories live in `~/.membook/store/` (`MEMBOOK_HOME` overrides), written with `membook remember --scope user`, joined into every recall — CLI, MCP and the prompt hook — served plainly and labeled as the human's own, and never entering any committed book. The repo store quarantines a user-scope file with directions to its real home, and the user store rejects anchored memories symmetrically. The index schema's `status` column became nullable for the projection (schema v2 — the usual loud rebuild).
