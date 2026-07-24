# @membook/spec

**The Memfile standard.** Schema, anchor grammar, validator, and deterministic
serialization for Membook memories.

This package is published independently and is free to implement. The format is
the standard; the verification loop is the product.

MIT © Stag.ai Ltd

## Versioning

`memfile: 1` in the frontmatter is the **format** version. It is deliberately
not the package version: `@membook/spec` will ship patches and features that do
not change the format at all, and an implementer pinning against the format
should not have to track our release cadence to know whether their reader still
works.

**`memfile` ticks when a file written under the new spec would fail validation
under the previous one.** Loosening a rule counts, because it is forward-
incompatible even though it looks permissive: older readers reject the newly
legal files. Adding an optional field does not count. Adding a new anchor
`kind` or provenance `origin` does not count — that is why both carry an
always-serialized discriminator.

**Until the format is published, v1 is still being drafted** and is amended in
place. That freedom ends at the first npm release; after it, the rule above is
binding and no correction is worth silently breaking a reader over.

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
  origin: distilled
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

`memorySchema` is this implementation's _reader_. It additionally tolerates
`Date` objects, because YAML 1.1 parsers (js-yaml, via gray-matter) silently
coerce unquoted ISO timestamps into dates, and an author cannot see the
difference between a quoted and unquoted timestamp in their own file.

That tolerance is **strictly one-directional**:

- **Read:** a `Date` is accepted and normalized to a canonical string.
- **Write:** a `Date` is rejected. It can never reach disk.

A tool that _emits_ real YAML timestamps is not spec-compliant, however forgiving
our reader happens to be.

### Timestamps are canonical UTC

Canonical form is `YYYY-MM-DDTHH:MM:SSZ` — always UTC, always the `Z` suffix,
always second precision (sub-second is truncated, never rounded).

Offsets and sub-second precision are accepted on input and normalized. A memory
written in Kochi and re-verified in London serializes identically, so a local
offset never shows up as a diff.

Timestamps are always serialized double-quoted, by explicit rule rather than by
the emitter's quoting heuristics.

### Provenance is shaped by who wrote it, and from what

Provenance carries two discriminators. `origin` says **how the memory came to
exist** and governs `source_hash`; within `authored`, `author` says **who wrote
it** and governs `agent` and `model`. Both are always serialized and lead the
block, with no default, because defaulting would silently mean the wrong thing.

| Shape                        | `session` | `agent` / `model` | `source_hash`                                                       |
| ---------------------------- | --------- | ----------------- | ------------------------------------------------------------------- |
| `distilled`                  | required  | required          | **required** — sha256 of the digest artifact the distiller consumed |
| `authored` + `author: agent` | optional  | required          | forbidden                                                           |
| `authored` + `author: human` | optional  | **forbidden**     | forbidden                                                           |

Forbidden, not optional — and that is the whole point. Under an optional field,
a hand-authored memory could carry a plausible-looking junk hash, or a person at
a terminal could invent a model they never used; an unfalsifiable assertion
dressed as provenance is worse for an auditor than no assertion at all. Because
absence is _enforced_, **presence is meaningful**: no field can appear without a
nameable referent behind it.

The net effect is that an auditor can reconstruct _who wrote this, from what, in
what context_ purely from which fields exist. "A human ratified this into the
book" and "an agent asserted it" are different claims, and the format keeps them
different.

The digest artifact lives in `.membook/` runtime storage, which is not
committed — so the audit claim is _locally_ verifiable where the archive exists,
and never globally. Provenance for an `authored` memory is the git history of
the commit that introduced it.

Future origins (`imported`, `registry`) stay additive, as with anchor `kind`.

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

### Ids are content-addressed, and collisions are specified

An id is `m-` plus the leading hex of `sha256(body)`, four characters by
default. Four hex characters is 16 bits, which is a small space once a repo
holds hundreds of memories, so collisions are expected rather than
hypothetical.

On collision the id extends **4 → 8 → 12** characters (`resolveMemoryId`).
Because a longer id is a prefix-extension of a shorter one, the ladder is
deterministic: the same content in the same store always resolves to the same
id. Exhausting the ladder throws rather than looping.

Ids are assigned once, at creation. They are not re-derived when a memory is
edited — memories evolve through PR review or `supersedes`, never by silently
renaming a file out from under a reviewer.

### Serialization is deterministic

Memories live in git and get reviewed in pull requests, so identical content must
produce byte-identical files: stable key order, normalized body whitespace, a
single trailing newline.

The load-bearing guarantee is a **named invariant** in the test suite:
serialization is a fixed point, so `serialize(parse(s))` reproduces `s` byte for
byte and `parse(serialize(m))` leaves `m` unchanged, for every golden file. Any
drift shows up as phantom diffs on files nobody edited.

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

| Field        | Required    | Notes                                                                                  |
| ------------ | ----------- | -------------------------------------------------------------------------------------- |
| `memfile`    | yes         | Spec version literal, currently `1`                                                    |
| `id`         | yes         | Content-addressed, `m-` + 4–12 lowercase hex                                           |
| `type`       | yes         | `decision` \| `gotcha` \| `convention` \| `map` \| `deadend`                           |
| `status`     | yes         | `unverified` \| `verified` \| `stale` \| `invalidated`                                 |
| `scope`      | yes         | `repo` \| `user` \| `team`                                                             |
| `confidence` | yes         | `0`–`1`                                                                                |
| `created`    | yes         | Canonical UTC timestamp                                                                |
| `verified`   | conditional | Required unless `status` is `unverified`                                               |
| `anchors`    | yes         | At least one                                                                           |
| `provenance` | yes         | `origin`, plus `author` when `authored`; remaining fields governed per the table above |
| `supersedes` | no          | Id of the memory this replaces                                                         |

Unknown fields are rejected.
