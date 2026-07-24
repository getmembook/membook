# @membook/spec

**The Memfile standard.** Schema, anchor grammar, validator, and deterministic
serialization for Membook memories.

This package is published independently and is free to implement. The format is
the standard; the verification loop is the product.

MIT © Stag.ai Ltd

## The Memfile format

A memory is one file — `<id>.mem.md` — with a YAML frontmatter machine layer and
a markdown body carrying the human statement.

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
    path: packages/core/src/index/sqlite.ts
    symbol: openIndex
    line_range: [18, 46]
    commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
provenance:
  session: sess-01H8X4M2
  agent: claude-code
  model: claude-opus-4-8
  source_hash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
---

`better-sqlite3` must be loaded after the process sets `PRAGMA journal_mode=WAL`,
or concurrent MCP sessions on the same repo deadlock on first write.
```

See [`examples/`](./examples) for one golden file per memory type. Those files
are generated, never hand-edited, and a round-trip test guards them as a fixed
point.

## What the standard requires

### The wire schema is the spec

`memoryWireSchema` — projected to JSON Schema as `memoryJsonSchema` — is the
normative contract. **All timestamps are strings.** It is what an external
implementer targets, what a distillation provider emits, and what every write
validates against.

`memorySchema` is this implementation's *reader*. It additionally tolerates
`Date` objects, because YAML 1.1 parsers (js-yaml, via gray-matter) silently
coerce unquoted ISO timestamps into dates, and an author cannot see the
difference between a quoted and unquoted timestamp in their own file.

That tolerance is **strictly one-directional**:

- **Read:** a `Date` is accepted and normalized to a canonical string.
- **Write:** a `Date` is rejected. It can never reach disk.

A tool that *emits* real YAML timestamps is not spec-compliant, however forgiving
our reader happens to be.

### Timestamps are canonical UTC

Canonical form is `YYYY-MM-DDTHH:MM:SSZ` — always UTC, always the `Z` suffix,
always second precision (sub-second is truncated, never rounded).

Offsets and sub-second precision are accepted on input and normalized. A memory
written in Kochi and re-verified in London serializes identically, so a local
offset never shows up as a diff.

Timestamps are always serialized double-quoted, by explicit rule rather than by
the emitter's quoting heuristics.

### Every memory carries at least one anchor

The anchor is the product. A memory with no anchor is not a memory — it is a
floating sentence, and the schema rejects it.

`kind` may be omitted on input (it defaults to `git`) but is always serialized,
and is always the first key in an anchor map. Anchor kinds are additive: the
lockfile-hash and API-contract anchors arriving in v0.2 do not break v1 files,
because v1 files already discriminate.

Anchor paths are repo-relative, with no absolute paths and no `.` or `..`
segments. Commits are full 40-character SHAs — abbreviations are ambiguous, and
verification cannot afford ambiguity.

### Serialization is deterministic

Memories live in git and get reviewed in pull requests, so identical content must
produce byte-identical files: stable key order, normalized body whitespace, a
single trailing newline. Round-tripping is a fixed point.

### Validation is loud

Every read and every write validates. A malformed memory raises
`MemfileValidationError` listing every issue and the offending file — it is never
silently skipped. Callers quarantine and report; use `safeParseMemfile` for bulk
reads that need to keep going.

## Anchor string grammar

The structured YAML form is canonical. A compact string form exists for CLI
output, logs, and docs:

```
git:<path>[#<symbol>][:L<start>[-<end>]]@<commit>
```

```
git:packages/core/src/store.ts@9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
git:src/auth.ts#refreshToken:L42-60@9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d
```

It is lossless for the structured form, but reserves `#` in paths and requires
the commit to be the final `@`-suffixed field.

## Usage

```ts
import {
  parseMemfile,
  serializeMemfile,
  safeParseMemfile,
  memoryJsonSchema,
} from "@membook/spec";

const { frontmatter, body } = parseMemfile(source, "m-6dd5.mem.md");

const text = serializeMemfile(frontmatter, body);

const result = safeParseMemfile(source, file);
if (!result.ok) quarantine(file, result.error.issues);
```

## Fields

| Field | Required | Notes |
| --- | --- | --- |
| `memfile` | yes | Spec version literal, currently `1` |
| `id` | yes | Content-addressed, `m-` + 4–12 lowercase hex |
| `type` | yes | `decision` \| `gotcha` \| `convention` \| `map` \| `deadend` |
| `status` | yes | `unverified` \| `verified` \| `stale` \| `invalidated` |
| `scope` | yes | `repo` \| `user` \| `team` |
| `confidence` | yes | `0`–`1` |
| `created` | yes | Canonical UTC timestamp |
| `verified` | conditional | Required unless `status` is `unverified` |
| `anchors` | yes | At least one |
| `provenance` | yes | `session`, `agent`, `model`, `source_hash` |
| `supersedes` | no | Id of the memory this replaces |

Unknown fields are rejected.
