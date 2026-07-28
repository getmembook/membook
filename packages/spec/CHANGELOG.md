# @membook/spec

## 0.3.0

### Minor Changes

- [#32](https://github.com/getmembook/membook/pull/32) [`72a5429`](https://github.com/getmembook/membook/commit/72a5429dadfba40e00413fd731105d6d46b8aa8a) Thanks [@hiranofficial](https://github.com/hiranofficial)! - Memfile v2: the `xgit` cross-repo anchor kind — and the version machinery keeping its promise.

  The spec gains `xgit` anchors (`kind: xgit, repo: <workspace member>, path, commit` — the same claim, pinned into a different repository), which is the breaking change the memfile version field existed for: `MEMFILE_SPEC_VERSION` is now 2. v1 files stay readable forever — they parse by widening into the current shape under a frozen v1 schema, byte-frozen v1 goldens guard the promise external implementers rely on, and `membook migrate` brings a store forward as one reviewable diff (this repo's own 12 memories crossed in exactly that way). The verify pass declines to check xgit-anchored memories rather than reporting partial coverage as a verdict — workspace verification is next. `scope: user` is reserved (rejected with its own message) until the anchorless user store lands.

- [#30](https://github.com/getmembook/membook/pull/30) [`e5a4ac6`](https://github.com/getmembook/membook/commit/e5a4ac6a7d8108f5bd2b9e84e57fea010db979c8) Thanks [@hiranofficial](https://github.com/hiranofficial)! - The workspace manifest and resolver — step 1 of the v0.2 multi-repo sequence.

  `@membook/spec` gains the workspace manifest schema (`workspace.yaml`: stable member names → checkouts), standard-surface because committed memories will reference the names it defines. `@membook/core` gains the resolver: per-member, non-fatal resolution with `~` expansion and meta-repo-relative paths, plus the normalized identity check — SSH and HTTPS forms of a repository are the same identity, a checkout with no origin resolves with its identity honestly unconfirmed, and the one loud refusal is a remote that exists and disagrees, because verifying against the wrong checkout would manufacture confident, wrong verdicts. Nothing consumes these yet; `xgit` anchors and `--workspace` build on them next.

- [#34](https://github.com/getmembook/membook/pull/34) [`c187d22`](https://github.com/getmembook/membook/commit/c187d22c2931c168eb9a6f8543d8ad1ca07c9b14) Thanks [@hiranofficial](https://github.com/hiranofficial)! - The scope discrimination and the user store: memories that follow the human.

  The spec's reserved slot fills in (v0.2 §8, ruled): `scope` is now a discriminated union. Repo and team memories keep the full lifecycle — anchors required, status, verification. A `user` memory FORBIDS anchors and has no `status` or `verified` in its shape at all: a preference is testimony about the human, not a checkable claim about the world, and verification is a category error against it, not a pending obligation. If you have a file to point at, it is not a preference.

  User memories live in `~/.membook/store/` (`MEMBOOK_HOME` overrides), written with `membook remember --scope user`, joined into every recall — CLI, MCP and the prompt hook — served plainly and labeled as the human's own, and never entering any committed book. The repo store quarantines a user-scope file with directions to its real home, and the user store rejects anchored memories symmetrically. The index schema's `status` column became nullable for the projection (schema v2 — the usual loud rebuild).

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
