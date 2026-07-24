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
recovery mechanism does not cover. The reverse ordering _would_ be unsafe: an
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

Every assumption that changes what the index _means_ is stamped into it:
schema version, spec version, FTS5 tokenizer, embedding model and dimensions.
If any drifts from the running build, opening the index throws rather than
repairing in place — old and new rows would disagree about tokenization or
embedding space, producing an index that looks healthy and retrieves badly.

The tokenizer is recorded verbatim (`unicode61 remove_diacritics 2`). Keeping
`_` a separator means `snake_case` still matches as an adjacent-token phrase
_and_ a bare `snake` matches, so recall strictly improves over `tokenchars`.
Changing that string is a forced rebuild, which is exactly the point.

`embedding_model` is `none` until vectors land — so enabling embeddings is
itself a mismatch, forcing a clean rebuild rather than leaving unembedded rows
silently invisible to vector search.

### Malformed files are quarantined, never skipped, never fatal

One corrupt memory must not cost the rebuild of two hundred good ones.
`reindex` continues the walk, reports the count, and surfaces it in `status`.

Quarantine writes a **report** and leaves the offending file in place.
`.membook/quarantine/` is gitignored, so _moving_ a committed memory there
would delete it from the working tree and the next commit would make that
permanent. A malformed memory is a file to repair, not to destroy.

### Writes validate against the wire schema only

The reader's tolerance for YAML-coerced `Date` values is one-directional and
never applies to a write, so a `Date` cannot reach disk through this path.

## The verify pass

For each memory, diff every anchor's commit against HEAD:

| Anchor                        | Outcome                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| untouched                     | re-verified **for free**                                       |
| modified                      | one targeted re-check                                          |
| renamed                       | followed, path rewritten, then re-checked                      |
| deleted                       | `invalidated` — the thing it described is gone                 |
| commit unknown to the repo    | `unverified` — history was rewritten, so nothing can be proven |
| path absent at its own commit | `unverified` — the anchor never described anything             |

A memory is only as good as its weakest anchor: worst outcome wins.

Diffs are cached per distinct anchor commit, so a hundred memories sharing a
baseline cost one `git diff`.

### Staleness is not cleared by the absence of change

Once a memory is `stale` or `invalidated`, later passes that find nothing
changed do **not** restore it. Absence of new change cannot retroactively
confirm a claim that was never confirmed — only a real re-check can.

This is enforced as a named invariant, and it is why anchor commits advance to
HEAD **only** when a memory actually verifies. `commit` means "the SHA this was
last proven against", so advancing it on a failed check would erase the
baseline the next re-check needs.

Renamed paths are rewritten regardless of verdict: an anchor pointing at a path
that no longer exists is strictly worse than a stale one that still resolves.

### The re-check seam

Deciding whether a memory survives a code change is a targeted LLM call —
build step 6. `AnchorRechecker` is the port, and it is on the real path today.

The default `ConservativeRechecker` **never confirms anything**: a changed file
with no configured checker yields `stale`, never `verified`. Defaulting the
other way would mark memories true because nobody was watching, which is the
exact failure this project exists to prevent.

```ts
const report = await membook.verify({ rechecker: new ClaudeRechecker() });
await membook.verify({ dryRun: true }); // report without writing
```

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
