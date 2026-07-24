---
"@membook/mcp": minor
"@membook/core": minor
"@membook/spec": patch
---

Add `@membook/mcp`, the stdio MCP server: `recall`, `remember`, and
`session_digest`. It spawns per session and exits — no daemon.

Retrieval is now hybrid and deliberately conservative. Relevance gates;
path proximity, recency and verification status only modulate it, so nothing
that fails on relevance can be rescued by being fresh or nearby. Results are
capped and floored, and when everything relevant is stale the caller is told
that rather than handed silence.

`spec`: a memory only needs a `verified` timestamp when its status is
`verified`. A memory created `unverified` whose anchored code then changes
becomes `stale` having never been verified, and that must be representable
without inventing a timestamp.
