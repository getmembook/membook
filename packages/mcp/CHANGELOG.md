# @membook/mcp

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
