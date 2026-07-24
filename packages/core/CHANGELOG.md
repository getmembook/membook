# @membook/core

## 0.1.0

### Minor Changes

- [`e41d84e`](https://github.com/getmembook/membook/commit/e41d84e1e4fdb40b489531381d1b2ce95b08ff82) Thanks [@hiranofficial](https://github.com/hiranofficial)! - Fill the three seams: secret scanning, LLM re-checking, and instrumentation.

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

- [`53af5f5`](https://github.com/getmembook/membook/commit/53af5f502fd39ba8b0b3147795e90ece158bab37) Thanks [@hiranofficial](https://github.com/hiranofficial)! - Initial pre-release of the Memfile standard and the storage engine.

  `@membook/spec` defines the format: Zod schema, anchor grammar, deterministic
  serialization, and a validator that fails loudly on read and on write.
  Provenance is discriminated so that every field's presence is meaningful — a
  `source_hash` appears only when a real artifact stands behind it, and a
  human-authored memory cannot express an `agent` or `model` it never had.

  `@membook/core` implements storage: file CRUD, a derived SQLite + FTS5 index
  with pinned assumptions, and `reindex`. Files are the truth; the database is a
  cache, rebuilt deterministically from them.

  Neither package is published yet.

- [`99ba26d`](https://github.com/getmembook/membook/commit/99ba26d22479afcd02907b807c09d2ab503edd02) Thanks [@hiranofficial](https://github.com/hiranofficial)! - Add the boot pack generator: `compileBook` and `writeBook` emit `MEMBOOK.md` at
  the repository root.

  Selection is greedy on expected-value-per-token under a hard 2,000-token cap.
  Status weights rather than gates — a young book is honestly all-unverified, so
  gating on `verified` would emit an empty book for exactly the repositories that
  most need one — while stale and invalidated memories are excluded outright,
  since the book is asserted with no room to caveat.

  Output is byte-identical for identical book state, because the file is
  committed and prepended to every session: unstable ordering would mean noisy
  diffs on a file nobody edited and a prompt-cache miss on every start.

- [`18c69ef`](https://github.com/getmembook/membook/commit/18c69ef0ab5eb3d624bd2bb2fdcf0110bb9458d9) Thanks [@hiranofficial](https://github.com/hiranofficial)! - Add `@membook/mcp`, the stdio MCP server: `recall`, `remember`, and
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

### Patch Changes

- Updated dependencies [[`53af5f5`](https://github.com/getmembook/membook/commit/53af5f502fd39ba8b0b3147795e90ece158bab37), [`18c69ef`](https://github.com/getmembook/membook/commit/18c69ef0ab5eb3d624bd2bb2fdcf0110bb9458d9)]:
  - @membook/spec@0.1.0
