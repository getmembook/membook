# membook

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
