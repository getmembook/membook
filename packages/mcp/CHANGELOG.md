# @membook/mcp

## 0.2.0

### Minor Changes

- [#32](https://github.com/getmembook/membook/pull/32) [`72a5429`](https://github.com/getmembook/membook/commit/72a5429dadfba40e00413fd731105d6d46b8aa8a) Thanks [@hiranofficial](https://github.com/hiranofficial)! - Memfile v2: the `xgit` cross-repo anchor kind — and the version machinery keeping its promise.

  The spec gains `xgit` anchors (`kind: xgit, repo: <workspace member>, path, commit` — the same claim, pinned into a different repository), which is the breaking change the memfile version field existed for: `MEMFILE_SPEC_VERSION` is now 2. v1 files stay readable forever — they parse by widening into the current shape under a frozen v1 schema, byte-frozen v1 goldens guard the promise external implementers rely on, and `membook migrate` brings a store forward as one reviewable diff (this repo's own 12 memories crossed in exactly that way). The verify pass declines to check xgit-anchored memories rather than reporting partial coverage as a verdict — workspace verification is next. `scope: user` is reserved (rejected with its own message) until the anchorless user store lands.

- [#35](https://github.com/getmembook/membook/pull/35) [`05f1e19`](https://github.com/getmembook/membook/commit/05f1e192c5f5652ab9f60110c26319317dcdc056) Thanks [@hiranofficial](https://github.com/hiranofficial)! - v0.2 completes: workspace surfaces, federated recall, and the boot context.

  `--workspace` reaches every remaining surface. `status -w` reports each member's resolution — identity confirmed, unconfirmed, or undeclared as three different facts — plus how many memories reach into it and how far it lags its upstream (information, never alarm, never a fetch). `book -w` admits cross-repo memories only when their repositories are present. The MCP server takes `MEMBOOK_WORKSPACE`.

  Federated recall lands under the hard rule: Membook never writes inside a checkout it did not init. Neighbour indexes build in `~/.membook/workspace-cache/<member>/`, keyed by indexed HEAD and rebuilt when it moves — same index code, same ranking, different location. Cross-repo hits carry `from <member>` provenance everywhere they are served, a remote hit never outranks an equally relevant local one, and the modifier cannot rescue a floor failure.

  `session_digest` gains the workspace context: what the neighbours know about this repository — cross-repo memories anchored into it — served live, capped, counted, and never committed; the book stays sovereign to its own store.

- [#34](https://github.com/getmembook/membook/pull/34) [`c187d22`](https://github.com/getmembook/membook/commit/c187d22c2931c168eb9a6f8543d8ad1ca07c9b14) Thanks [@hiranofficial](https://github.com/hiranofficial)! - The scope discrimination and the user store: memories that follow the human.

  The spec's reserved slot fills in (v0.2 §8, ruled): `scope` is now a discriminated union. Repo and team memories keep the full lifecycle — anchors required, status, verification. A `user` memory FORBIDS anchors and has no `status` or `verified` in its shape at all: a preference is testimony about the human, not a checkable claim about the world, and verification is a category error against it, not a pending obligation. If you have a file to point at, it is not a preference.

  User memories live in `~/.membook/store/` (`MEMBOOK_HOME` overrides), written with `membook remember --scope user`, joined into every recall — CLI, MCP and the prompt hook — served plainly and labeled as the human's own, and never entering any committed book. The repo store quarantines a user-scope file with directions to its real home, and the user store rejects anchored memories symmetrically. The index schema's `status` column became nullable for the projection (schema v2 — the usual loud rebuild).

### Patch Changes

- Updated dependencies [[`72a5429`](https://github.com/getmembook/membook/commit/72a5429dadfba40e00413fd731105d6d46b8aa8a), [`7d544ca`](https://github.com/getmembook/membook/commit/7d544cae53bb4a0ae775675c838a9b4dc2e2271b), [`05f1e19`](https://github.com/getmembook/membook/commit/05f1e192c5f5652ab9f60110c26319317dcdc056), [`e5a4ac6`](https://github.com/getmembook/membook/commit/e5a4ac6a7d8108f5bd2b9e84e57fea010db979c8), [`c187d22`](https://github.com/getmembook/membook/commit/c187d22c2931c168eb9a6f8543d8ad1ca07c9b14)]:
  - @membook/spec@0.3.0
  - @membook/core@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [[`47f6d4e`](https://github.com/getmembook/membook/commit/47f6d4e0bdc1f5d4e2a0694cc8eafdaba360d53d)]:
  - @membook/spec@0.2.0
  - @membook/core@0.2.0

## 0.1.2

### Patch Changes

- [#22](https://github.com/getmembook/membook/pull/22) [`c12907d`](https://github.com/getmembook/membook/commit/c12907ddcb7c6ed96164e93ba8d9038dd6febd9b) Thanks [@hiranofficial](https://github.com/hiranofficial)! - `SERVER_VERSION` reads package.json at runtime instead of a hardcoded string,
  so the version the MCP server reports to clients tracks the release. Same
  drift class as the CLI's `--version` bug; same guard test.

## 0.1.1

### Patch Changes

- Updated dependencies [[`e41e553`](https://github.com/getmembook/membook/commit/e41e5535539e39ef5affb69042c8d4e625a8c3a4), [`e41e553`](https://github.com/getmembook/membook/commit/e41e5535539e39ef5affb69042c8d4e625a8c3a4), [`e41e553`](https://github.com/getmembook/membook/commit/e41e5535539e39ef5affb69042c8d4e625a8c3a4)]:
  - @membook/core@0.1.1

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

- Updated dependencies [[`e41d84e`](https://github.com/getmembook/membook/commit/e41d84e1e4fdb40b489531381d1b2ce95b08ff82), [`53af5f5`](https://github.com/getmembook/membook/commit/53af5f502fd39ba8b0b3147795e90ece158bab37), [`99ba26d`](https://github.com/getmembook/membook/commit/99ba26d22479afcd02907b807c09d2ab503edd02), [`18c69ef`](https://github.com/getmembook/membook/commit/18c69ef0ab5eb3d624bd2bb2fdcf0110bb9458d9)]:
  - @membook/core@0.1.0
  - @membook/spec@0.1.0
