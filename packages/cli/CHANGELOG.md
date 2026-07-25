# membook

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
