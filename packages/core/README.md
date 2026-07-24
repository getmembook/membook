# @membook/core

The Membook engine: store, index, retrieve.

**Files are the truth; the database is a cache.** Everything here follows from
that one sentence.

MIT © Stag.ai Ltd

## Layout

```
.membook/
  memories/     canonical, committed, the truth
  index/        SQLite cache — gitignored, disposable, rebuilt by reindex
  quarantine/   reports for files that failed validation — gitignored
```

## The invariants

### Write ordering is file-first, always

The file lands, then the index updates. A crash between the two leaves the
index stale — which is **by definition healable**, because `reindex` rebuilds
it from the files. That is the entire crash story.

There is deliberately no two-phase commit. Coordinating a source of truth with
its own disposable cache would only add failure modes that the existing
recovery mechanism does not cover. The reverse ordering *would* be unsafe: an
indexed memory with no file is a phantom `reindex` can only forget, not heal.

### Rebuilds are deterministic

`delete DB → reindex → identical retrieval` is the gate this package is built
against, and it is enforced by tests. Determinism depends on:

- **A sorted file walk.** `readdir` order is filesystem-dependent; an index
  built in a different order is a different index.
- **Rowids assigned from that sorted walk**, so BM25 tie-breaking is
  reproduced rather than merely equivalent.
- **Deterministic ranking** — ties break by id, so ranking never depends on
  insertion history.

A rebuild deletes the database file rather than emptying it, so nothing is
inherited from a previous build, including metadata stamped by older code.

### Index metadata is pinned, and mismatch fails loudly

Every assumption that changes what the index *means* is stamped into it:
schema version, spec version, FTS5 tokenizer, embedding model and dimensions.
If any drifts from the running build, opening the index throws rather than
repairing in place — old and new rows would disagree about tokenization or
embedding space, producing an index that looks healthy and retrieves badly.

The tokenizer is recorded verbatim (`unicode61 remove_diacritics 2`). Keeping
`_` a separator means `snake_case` still matches as an adjacent-token phrase
*and* a bare `snake` matches, so recall strictly improves over `tokenchars`.
Changing that string is a forced rebuild, which is exactly the point.

`embedding_model` is `none` until vectors land — so enabling embeddings is
itself a mismatch, forcing a clean rebuild rather than leaving unembedded rows
silently invisible to vector search.

### Malformed files are quarantined, never skipped, never fatal

One corrupt memory must not cost the rebuild of two hundred good ones.
`reindex` continues the walk, reports the count, and surfaces it in `status`.

Quarantine writes a **report** and leaves the offending file in place.
`.membook/quarantine/` is gitignored, so *moving* a committed memory there
would delete it from the working tree and the next commit would make that
permanent. A malformed memory is a file to repair, not to destroy.

### Writes validate against the wire schema only

The reader's tolerance for YAML-coerced `Date` values is one-directional and
never applies to a write, so a `Date` cannot reach disk through this path.

## The write-path seam

Every write passes through configured `WriteGuard`s before touching disk. A
guard returning findings blocks the write entirely and nothing is written.

The default is `NoopWriteGuard`, which passes everything and is named to be
honest about it. The launch-blocking secret scanner is build step 6 and slots
in as an implementation, with no call-site changes:

```ts
const membook = new Membook(root, { guards: [new GitleaksGuard()] });
```

## Usage

```ts
import { Membook } from "@membook/core";

const membook = new Membook(process.cwd());

await membook.remember(frontmatter, body);
const hits = await membook.recall("journal_mode WAL deadlock");
const { indexed, quarantined } = await membook.reindex();
const report = await membook.status();
```

`recall` defaults to `any` matching: BM25 ranks partial matches, because an
all-terms query degrades to returning nothing, which hands an agent no memory
at all rather than an imperfect one. Precision is enforced by ranking, the
response cap, and status filters. Pass `{ mode: "all" }` to require every term.

Queries are escaped before reaching FTS5 — raw punctuation is a syntax error
there, so an unescaped path-shaped query would crash rather than return
nothing, and operators like `AND` are treated as words rather than injected.
