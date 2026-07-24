# membook

**Memory that stays true.** The command line for
[Membook](https://github.com/getmembook/membook) — durable project knowledge,
anchored to code and checked against it.

MIT © Stag.ai Ltd

```bash
npx membook init
```

## The human's surface

The MCP server is the agent's surface; this is the person's. That difference
shapes the whole tool:

- **`review`** is where a human ratifies or rejects what an agent recorded.
- **`status`** is where trust is explained, not just counted.
- **`remember`** writes a memory as `author: human` — with `agent` and `model`
  structurally absent, because a person at a terminal has neither.

## Commands

### `membook init [--hooks]`

Creates `.membook/memories/`, adds the derived paths to `.gitignore`, writes an
initial `MEMBOOK.md`, and prints how to connect an agent. Idempotent.

Memories and `MEMBOOK.md` are **committed**; the index, quarantine and
telemetry are not. Files are the truth.

`--hooks` also installs a Claude Code `UserPromptSubmit` hook, so relevant
memory is recalled on every prompt without the agent having to ask. It is
opt-in on purpose: hooks are Claude Code-specific, while `MEMBOOK.md` works with
any agent, so the portable path stays the default.

### `membook status [--check]`

What is known and how far to trust it. Each status is explained rather than
named, because the counts alone do not tell a person what to do:

```
  3  verified     checked against the current code
  1  unverified   not checked yet
  2  stale        the code it describes has changed
```

"Nothing is recorded" and "things are recorded but have drifted" call for
opposite responses — write something, versus go and re-check what you wrote —
so they read as different sentences, not different integers.

`--check` diffs anchors against HEAD and reports what _would_ change, writing
nothing.

### `membook verify [--dry-run] [--recheck] [-m <model>]`

Re-checks memories against the current code. Untouched anchors re-verify for
free; drifted ones become stale.

Stale memories are **not** restored by the absence of further change — only a
re-check can restore them. `--recheck` asks a model, and needs
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Without a key it refuses rather than
guessing: a memory wrongly restored is worse than one left stale. `-m, --model`
overrides the model the re-check uses.

### `membook recall <query> [-p <path>] [--include-stale] [-n <limit>]`

See what an agent would be served for a query — the same ranked, floored,
capped result the MCP `recall` returns, so you can inspect retrieval yourself
rather than guess at it. `-p` names files you are working on, which lifts
memories anchored to them; `--include-stale` also shows drifted memories;
`-n` caps how many come back.

### `membook seed [--dry-run] [-n <max-files>] [--model <model>]`

Distil what the repository already documents — `CLAUDE.md`, `AGENTS.md`, ADRs,
design docs — into candidate memories, so the book is useful before any agent
has recorded anything. Needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

Every candidate is written `unverified` and anchored to the file it came from,
for a human to ratify in `review`. Rejection is the default: a candidate that
cites a file which does not exist, or carries a secret, is dropped. `--dry-run`
shows what would be recorded without writing.

### `membook distill [file] [--dry-run] [--model <model>]`

Turn notes from a working session into candidate memories — the write side of
the same pipeline as `seed`. Reads a file, or stdin when none is given. Needs a
model key, rejects by default, and writes `unverified` for `review`.

Not passive capture: something has to hand the notes over deliberately.

### `membook review [--list]`

The human ratification surface. For each memory nobody has decided on:

```
  [k]eep and ratify · [d]elete · [s]kip · [q]uit
```

Ratifying marks it `verified` and re-anchors it to HEAD, because a person
reading the code and confirming the statement _is_ a verification — the
strongest kind available. Deleting removes the file: a memory nobody will
stand behind should not be served to anyone.

### `membook remember <statement> -p <path>`

Record something yourself.

```bash
membook remember "Deploys are gated on the migration job finishing first." \
  -p infra/deploy.ts -t convention
```

Every memory must name at least one file. An unanchored memory cannot be
verified, so it is refused rather than stored. Writes are secret-scanned;
a match blocks the write entirely.

### `membook book` / `membook reindex`

Regenerate `MEMBOOK.md`, and rebuild the search index from the files. The index
is a disposable cache — delete it any time.

## Options

`-C, --cwd <path>` runs as if started in that directory.
