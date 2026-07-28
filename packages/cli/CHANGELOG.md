# membook

## 0.3.0

### Minor Changes

- [#32](https://github.com/getmembook/membook/pull/32) [`72a5429`](https://github.com/getmembook/membook/commit/72a5429dadfba40e00413fd731105d6d46b8aa8a) Thanks [@hiranofficial](https://github.com/hiranofficial)! - Memfile v2: the `xgit` cross-repo anchor kind — and the version machinery keeping its promise.

  The spec gains `xgit` anchors (`kind: xgit, repo: <workspace member>, path, commit` — the same claim, pinned into a different repository), which is the breaking change the memfile version field existed for: `MEMFILE_SPEC_VERSION` is now 2. v1 files stay readable forever — they parse by widening into the current shape under a frozen v1 schema, byte-frozen v1 goldens guard the promise external implementers rely on, and `membook migrate` brings a store forward as one reviewable diff (this repo's own 12 memories crossed in exactly that way). The verify pass declines to check xgit-anchored memories rather than reporting partial coverage as a verdict — workspace verification is next. `scope: user` is reserved (rejected with its own message) until the anchorless user store lands.

- [#33](https://github.com/getmembook/membook/pull/33) [`7d544ca`](https://github.com/getmembook/membook/commit/7d544cae53bb4a0ae775675c838a9b4dc2e2271b) Thanks [@hiranofficial](https://github.com/hiranofficial)! - Workspace verification: contract-watch across repositories, and the third epistemic state.

  The verify pass gains its working-tree parameter — it was always a pure function of `(anchor, checkout)`, and now an `xgit` anchor runs the unchanged diff, rename-follow and transition logic inside the resolved member's checkout, advancing to that repository's HEAD when it proves out. A member this machine cannot use yields `unresolvable`: not stale (nothing is known to have changed), not verified (nothing was checked), never folded into either. An unresolvable anchor blocks confirmation but not conviction — a deleted or drifted local anchor still demotes — and the boot pack withholds unresolvable-anchored memories under their own honest count, separate from drifted. `membook verify --workspace [manifest]` wires it up; without a workspace, cross-repo anchors are reported as unreachable with the member named, not treated as errors. The fixture harness grows a multi-repo `workspaceFixture`, and the v0.2 signature demo — producer edits the contract, consumer's memory flips stale before an agent writes code against the old shape — runs as an automated test, including the producer-rename case.

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

## 0.2.0

### Minor Changes

- [#28](https://github.com/getmembook/membook/pull/28) [`47f6d4e`](https://github.com/getmembook/membook/commit/47f6d4e0bdc1f5d4e2a0694cc8eafdaba360d53d) Thanks [@hiranofficial](https://github.com/hiranofficial)! - The write half of the memfile version machinery, landed before v2 needs it.

  `parseMemfile` now reports the version a file declared on disk (`Memfile.version`) — after read-widening, the only remaining trace of what the file actually said. `membook status` counts the version spread of the store, and the new `membook migrate` rewrites every memory to the current canonical form in one pass a human reviews and commits: older versions come forward, hand-drifted files return to canonical serialization, and files from a newer Membook are skipped rather than downgraded. Nothing rewrites a committed file as a side effect of having read it.

### Patch Changes

- Updated dependencies [[`47f6d4e`](https://github.com/getmembook/membook/commit/47f6d4e0bdc1f5d4e2a0694cc8eafdaba360d53d)]:
  - @membook/spec@0.2.0
  - @membook/core@0.2.0

## 0.1.2

### Patch Changes

- [#22](https://github.com/getmembook/membook/pull/22) [`c12907d`](https://github.com/getmembook/membook/commit/c12907ddcb7c6ed96164e93ba8d9038dd6febd9b) Thanks [@hiranofficial](https://github.com/hiranofficial)! - `membook --version` reads the version from package.json at runtime instead of
  a hardcoded string. The published 0.1.1 introduced itself as 0.1.0; changesets
  bumps the manifest, and a constant nobody remembers is wrong by the second
  release. A test now pins the binary's answer to the manifest.

## 0.1.1

### Patch Changes

- [#20](https://github.com/getmembook/membook/pull/20) [`e41e553`](https://github.com/getmembook/membook/commit/e41e5535539e39ef5affb69042c8d4e625a8c3a4) Thanks [@hiranofficial](https://github.com/hiranofficial)! - `membook review` re-flows hard-wrapped memory bodies before display, and
  re-asks on input it does not recognize instead of silently skipping — typed
  `dd` meaning delete, the old behaviour printed "Skipped." and moved on, which
  on a prompt with a destructive option is the worst way to be wrong. EOF still
  quits, so piped input cannot loop.
- Updated dependencies [[`e41e553`](https://github.com/getmembook/membook/commit/e41e5535539e39ef5affb69042c8d4e625a8c3a4), [`e41e553`](https://github.com/getmembook/membook/commit/e41e5535539e39ef5affb69042c8d4e625a8c3a4), [`e41e553`](https://github.com/getmembook/membook/commit/e41e5535539e39ef5affb69042c8d4e625a8c3a4)]:
  - @membook/core@0.1.1

## 0.1.0

### Minor Changes

- [`277e479`](https://github.com/getmembook/membook/commit/277e479c1a46779a8b773377ffd1b48198c95155) Thanks [@hiranofficial](https://github.com/hiranofficial)! - Add the `membook` CLI: `init`, `status`, `verify`, `review`, `remember`,
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

### Patch Changes

- Updated dependencies [[`e41d84e`](https://github.com/getmembook/membook/commit/e41d84e1e4fdb40b489531381d1b2ce95b08ff82), [`53af5f5`](https://github.com/getmembook/membook/commit/53af5f502fd39ba8b0b3147795e90ece158bab37), [`99ba26d`](https://github.com/getmembook/membook/commit/99ba26d22479afcd02907b807c09d2ab503edd02), [`18c69ef`](https://github.com/getmembook/membook/commit/18c69ef0ab5eb3d624bd2bb2fdcf0110bb9458d9)]:
  - @membook/core@0.1.0
  - @membook/spec@0.1.0
