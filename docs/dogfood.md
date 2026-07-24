# Dogfood log

Two weeks of ordinary work with Membook running on a real repository. Plain
entries: what happened, what the tool did, what annoyed you.

The annoyances are the point. They are v0.2's backlog arriving in order of
truth rather than in order of what seemed clever to build.

## The release gate

v0.1 does not ship until all five hold, on this log's evidence:

- [ ] Cold `npx membook init` works on a clean machine
- [ ] The signature demo runs unrehearsed — a memory drifts, `status` says so,
      and the next session gets the corrected book
- [ ] Instrumentation shows a non-zero recall hit rate
- [ ] At least one genuine staleness catch, on work nobody staged for it
- [ ] Zero secrets ever written

Evidence lives in `.membook/telemetry/events.jsonl`, which is local and
gitignored. Paste the relevant lines into an entry rather than committing it.

## Entries

### 2026-07-24 — the tool caught its own drift

**What happened.** Ordinary work: edited `packages/spec/src/schema.ts` to
loosen the verified-timestamp rule.

**What the tool did.** The next `verify` turned three memories stale —
all three anchored to that file — and `MEMBOOK.md` withheld them, dropping
from three entries to one. Nobody staged this; it was a side effect of an
unrelated change.

**What annoyed me.** Nothing, but it exposed the cost honestly: those three
decisions are still true, and without a re-checker nothing can restore them.
The book is thinner and correct rather than fuller and wrong. That is the
right trade, and it is also the strongest argument for having built step 6.

### 2026-07-24 — gitleaks blocked the secret scanner's own tests

**What happened.** Committing the secret-scan work.

**What the tool did.** Not Membook — the repo's own gitleaks pre-commit hook
refused the commit, catching the credential-shaped literals the scanner tests
need.

**What annoyed me.** Two rounds to fix, because leak detection is
context-sensitive: a fragment matching no rule alone still tripped
`generic-api-key` purely by sitting next to a property named `...Key:`.
Recorded as `m-0542`. The fix was assembling fixtures at runtime rather than
an allowlist — an allowlist entry in this repo would be a published tutorial
in annotating past a scanner.

### 2026-07-24 — the ratification surface ate a ratification

**What happened.** Testing `membook review` by piping `k` to the built binary.

**What the tool did.** Reported "0 ratified" and exited cleanly. The answer was
silently discarded: the readline reader was created before the async setup and
drained piped stdin before the first prompt.

**What annoyed me.** That the unit tests could not have caught it — they inject
`ask`, so the suite structurally never exercised the path that ships, and the
failure presented as success. Recorded as `m-d394`: every injectable boundary
needs at least one test through the real thing.

### Pending

- [ ] **First live re-check.** Four memories are stale whose ground truth we
      know: they are still true. Run
      `ANTHROPIC_API_KEY=… membook verify --recheck`, record every verdict,
      then regenerate the book and read the header. Four `restore` verdicts
      means the skeptic can recognise affirmative evidence; any `still-stale`
      is prompt-calibration data, not failure — the bias was specified, so a
      conservative miss on first contact is the system erring as instructed.
