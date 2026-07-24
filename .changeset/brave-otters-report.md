---
"@membook/core": minor
"@membook/mcp": minor
---

Fill the three seams: secret scanning, LLM re-checking, and instrumentation.

The scanner is deny-biased. A false positive blocks a memory and a human looks
at it; a false negative commits a credential forever — so when a rule is torn,
it blocks. It scans the whole serialized memory, redacts findings in every
message, and is **on by default in the MCP server**, since a guard that had to
be opted into would protect nobody.

The re-checker is a skeptic, not a judge. Its dangerous failure is the false
restore, so every path that is not an explicit, schema-valid verdict leaves the
memory stale: unparseable reply, failed repair, provider down, unknown verdict.
One repair attempt asks only for the shape, never re-arguing the substance. The
prompt is versioned in `prompts/recheck.md`.

Instrumentation is a local append-only JSONL file and never touches the
network. It records what recall served _and withheld_, verify transitions,
re-check verdicts, blocked writes, and book counts — so the product's claims
become numbers a user can check locally. Logging swallows its own errors,
because telemetry must never break what it observes.
