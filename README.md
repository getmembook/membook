# Membook

**Memory that stays true.** A verifiable memory engine for coding agents.

[![CI](https://github.com/getmembook/membook/actions/workflows/ci.yml/badge.svg)](https://github.com/getmembook/membook/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/membook/alpha?label=npm%40alpha)](https://www.npmjs.com/package/membook)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](./package.json)

Coding agents forget. Worse, they misremember: a memory saying "we use Jest"
survives the migration to Vitest and gets served to the agent as fact.

Membook anchors every memory to **checkable reality** — a commit, a file, a
symbol — so when the code changes, the memory knows. Storage is plain markdown
committed to your repo: it renders on GitHub, diffs in pull requests, and
survives review like any other artifact.

> **Pre-release.** Everything below is built and tested, but the release gate
> has not been met: Membook has not yet been lived with on a real project for
> long enough to know whether it helps. The npm badge above is the current
> answer to "can I install this" — no `latest` tag means no release yet.
> Expect breaking changes.

## Why it's different

Every memory system in the market stores text that nothing keeps honest.
Membook's differentiator is the **verification loop**:

1. A memory is stored with one or more **anchors** — `{path, symbol?, commit}`.
2. Verification diffs `commit..HEAD` against the anchor paths.
3. Untouched paths re-verify for free. Touched paths get one targeted re-check.
4. The memory becomes `verified`, `stale`, or `invalidated` — and says so.

A memory that cannot be checked against reality is a floating sentence. The
schema rejects one with no anchor.

## Design commitments

These are settled, and the code enforces them:

- **Files are the truth; the database is a cache.** Canonical state is one
  markdown file per memory. SQLite is derived, disposable, and rebuilt
  bit-identically by `reindex`. Delete it any time.
- **No daemon.** Nothing resident, no ports, no background processes.
- **Local-first.** No network telemetry, ever.
- **Honest status.** A memory is `unverified` until something actually
  verifies it. This repo's own memories are `unverified` today, because the
  verify pass does not exist yet — claiming otherwise would be exactly the
  unfalsifiable assertion the project exists to prevent.
- **MIT, genuinely.** Not Elastic-licensed, not source-available.

## A memory

```markdown
---
memfile: 1
id: m-6dd5
type: gotcha
status: verified
scope: repo
confidence: 0.9
created: "2026-07-21T16:42:00Z"
verified: "2026-07-24T08:00:00Z"
anchors:
  - kind: git
    path: packages/core/src/index-db.ts
    symbol: openIndex
    line_range: [18, 46]
    commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
provenance:
  origin: distilled
  session: sess-01H8X4M2
  agent: claude-code
  model: claude-opus-4-8
  source_hash: e3b0c442…
---

`better-sqlite3` must be loaded after the process sets `PRAGMA journal_mode=WAL`,
or concurrent MCP sessions on the same repo deadlock on first write.
```

Provenance is shaped so that **presence is meaningful**: a hash appears only
when a real artifact stands behind it, and a human-authored memory cannot
express an `agent` or `model` it never had. An auditor can reconstruct who
wrote a memory, from what, and in what context, purely from which fields exist.

## Status

| Package                            | What it is                                                     | State                |
| ---------------------------------- | -------------------------------------------------------------- | -------------------- |
| [`@membook/spec`](./packages/spec) | The Memfile standard — schema, anchor grammar, validator       | **Built**, 101 tests |
| [`@membook/core`](./packages/core) | Engine — store, index, verify, recall, book                    | **Built**, 188 tests |
| [`@membook/mcp`](./packages/mcp)   | MCP server (`remember` / `recall` / `session_digest`)          | **Built**, 20 tests  |
| Verify pass                        | The verification loop + fixture harness                        | **Built**            |
| Boot pack                          | `MEMBOOK.md` generator                                         | **Built**            |
| The three seams                    | Secret scanner, LLM re-checker, instrumentation                | **Built**            |
| [`membook`](./packages/cli)        | CLI (`init`, `status`, `review`, `verify`, `remember`, `book`) | **Built**, 25 tests  |
| Distillation                       | Session digest → candidate memories                            | Not started          |

Distillation is deliberately out of scope for v0.1 — the memories an agent
records through `remember` are the ones that matter first.

## Platform support

**macOS and Linux for v0.1.** Windows is built in CI but not gated on.

Windows installs and runs: `@membook/spec` passes its full suite there, and
the rest is close. What fails is temp-directory cleanup — SQLite holds a file
handle open, and Windows refuses to unlink a file that is open, so a handful
of tests error on teardown rather than on anything they were testing.

That is a smaller and more tractable problem than it used to be — until
recently `better-sqlite3` could not compile there at all — but "close" is not
"supported", so v0.1 does not claim it. Windows is a v0.2 question.

## Development

Requires Node ≥ 20 (the repo pins 24 via [mise](https://mise.jdx.dev) and
`.nvmrc`) and [pnpm](https://pnpm.io) 9.

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm build && pnpm typecheck
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow, and
[CLAUDE.md](./CLAUDE.md) for architecture decisions and the build order — it is
the build context for both humans and coding agents.

## The standard

The Memfile format is documented in
[`packages/spec/README.md`](./packages/spec/README.md) and published as a JSON
Schema. It is deliberately free to implement: the format is a standard we would
like others to adopt, and the verification loop is the product.

## Security

Memories get committed, so a secret written into one is persisted and pushed.
Every write is therefore scanned before it reaches `.membook/`, and the scanner
is **deny-biased**: a false positive costs a human glance, a false negative
commits a credential forever, so when a rule is torn it blocks. It is on by
default in the MCP server.

Regex scanning is a floor, not a ceiling — a passing scan is not permission to
paste secrets at Membook. Please report vulnerabilities privately, and a missed
credential class counts — see [SECURITY.md](./SECURITY.md).

## License

MIT © Stag.ai Ltd
