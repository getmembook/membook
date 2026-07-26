# @membook/spec

## 0.2.0

### Minor Changes

- [#28](https://github.com/getmembook/membook/pull/28) [`47f6d4e`](https://github.com/getmembook/membook/commit/47f6d4e0bdc1f5d4e2a0694cc8eafdaba360d53d) Thanks [@hiranofficial](https://github.com/hiranofficial)! - The write half of the memfile version machinery, landed before v2 needs it.

  `parseMemfile` now reports the version a file declared on disk (`Memfile.version`) — after read-widening, the only remaining trace of what the file actually said. `membook status` counts the version spread of the store, and the new `membook migrate` rewrites every memory to the current canonical form in one pass a human reviews and commits: older versions come forward, hand-drifted files return to canonical serialization, and files from a newer Membook are skipped rather than downgraded. Nothing rewrites a committed file as a side effect of having read it.

## 0.1.0

### Minor Changes

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

### Patch Changes

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
