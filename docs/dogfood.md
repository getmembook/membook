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

### 2026-07-24 — first live re-check: no verdicts, but the failure path held

**What happened.** Ran `membook verify --recheck` with a real key against the
three stale founding memories. (The earlier entry said four; a verify pass in
between promoted one, so it was three. Corrected forward rather than edited,
because a log rewritten for tidiness is the same instinct as a header softened
for marketing.)

**What the tool did.** Two bugs first, both found by running it rather than by
any test:

1. `recheckerFromEnv` never passed instrumentation to the `LlmRechecker`, so
   verdicts went to a `NullInstrumentation`. Re-check accuracy — the single
   number that seam exists to make measurable — was silently not recorded.
2. A `still-stale` verdict does not change status, so it landed in
   `unchanged` and the CLI printed _"nothing changed"_. That folds "we asked
   and were told no" together with "we never asked", which are different
   facts about how much is known. Same family as the `MEMBOOK.md` header bug.

With both fixed, the re-check ran and the API refused it: the account has no
credit balance. Every memory stayed stale, each with the reason naming the
cause, and the telemetry recorded three `failed: true` verdicts attributed to
`llm:anthropic:claude-sonnet-5`.

**What annoyed me.** No calibration data — the model was never reached, so we
still do not know whether the skeptic can recognise affirmative evidence. That
needs a funded account.

**What it got right.** This was the first live exercise of the provider-failure
path, and it behaved exactly as specified: an unreachable model is not evidence
of anything, so nothing was restored and nothing was assumed. The dangerous
outcome here was a false restore on an API error, and it did not happen.

### 2026-07-24 — the floor read: right verdicts, wrong reasoning

**What happened.** Twelve failed re-checks against a local Ollama, all
attributed to `gpt-4o-mini`, because the model override existed only as
`MEMBOOK_MODEL` and nothing surfaced its name. Added `--model`, then ran
`verify --recheck --model qwen2.5-coder:3b` against the three known-true
memories.

**What the tool did.** 3/3 `restore`. Matching ground truth — but read the
reasons the prompt demanded:

- `m-83be` (about **quoted UTC timestamps**): _"`gitAnchorSchema` was
  modified, and now requires `commitSha`."_ A different memory's subject
  entirely. Non-sequitur.
- `m-88a8` (about the **wire schema being the standard**): _"`anchorSchema`
  extends `gitAnchorSchema`, so any modification to `gitAnchorSchema` in the
  same file **could cause issues**."_ That is an argument for caution,
  returned alongside a restore.
- `m-be36` (about **explicit anchor `kind`**): _"The added 'kind' field ... is
  not present in v0.1"_ — factually wrong; its presence in v0.1 is the whole
  memory.

**The finding.** Schema validity is not a proxy for reasoning quality. The
structured-output layer worked perfectly — valid JSON, valid enum, non-empty
reason, zero repairs — and produced three citations that do not support the
verdicts they accompany, one of which argues the other way. This is the most
dangerous shape of pass: correct by coincidence. A 3B model can satisfy
"cite the specific code that decided it" without the citation deciding
anything, and cannot execute "absence of contradiction is not evidence."

**What it means for the gate.** The skeptic bias lives in the prompt, and a
prompt cannot make a small model skeptical. Re-checker accuracy has to be
measured on reasons, not verdicts — a verdict-only score would have read
100% here. The three memories are left `verified` because ground truth agrees,
but the mechanism that restored them is not one to trust; `membook review`
exists precisely for a human to ratify these properly.

**Also.** Four identical failed runs in five minutes were a human retrying in
hope. The CLI now detects that every re-check failed with the same error and
says it is configuration rather than transience.

**The book's full breath**, verbatim, after restoration:

> It carries all 7 eligible memories. This file is generated, never edited by
> hand — corrections belong in `.membook/memories/`.

From "carries the one eligible memory, 3 further withheld" to full coverage,
with the withheld sentence correctly absent.

### Pending

- [ ] **Calibration read on a frontier model.** The floor is measured; the
      ceiling is not. Re-run against a larger model and compare _reasons_, not
      verdict counts. The open question is whether re-check quality is a model
      capability or a prompt problem — this run says a 3B cannot do it, and
      says nothing yet about what can.
- [x] ~~Re-run `verify --recheck` and capture the verdicts.~~ Done above, on a
      local model. It also retired the framing this entry was written under:
      "three `restore` verdicts means the skeptic recognises affirmative
      evidence" turned out to be false. Three restores arrived on reasoning
      that recognised nothing, which is why the pending item above measures
      reasons rather than counting verdicts.
