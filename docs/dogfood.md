# Dogfood log

Two weeks of ordinary work with Membook running on a real repository. Plain
entries: what happened, what the tool did, what annoyed you.

The annoyances are the point. They are v0.2's backlog arriving in order of
truth rather than in order of what seemed clever to build.

## The release gate

v0.1 does not ship until all five hold, on this log's evidence:

- [x] Cold `npx membook init` works on a clean machine — 2026-07-24
- [ ] The signature demo runs unrehearsed — a memory drifts, `status` says so,
      and the next session gets the corrected book
- [ ] Instrumentation shows a non-zero recall hit rate
- [ ] At least one genuine staleness catch, on work nobody staged for it
- [ ] Zero secrets ever written

## Also measure, for v0.2

Free to collect while the clock runs, expensive to discover afterwards.

- [ ] **Merge style of every producer repo in the Stag workspace.** If squash
      merges are common, cross-repo anchors are orphaned on every merge and
      contract-watch-lite collapses into permanent `unresolvable`. The
      contingent hedge — a blob hash alongside the commit — is designed and
      waiting in [v0.2-workspaces.md](design/v0.2-workspaces.md) §11, but the
      measurement decides whether it gets built.

Evidence lives in `.membook/telemetry/events.jsonl`, which is local and
gitignored. Paste the relevant lines into an entry rather than committing it.

## Entries

### 2026-07-24 — first gate closed: cold start works

**What happened.** Published `0.1.0-alpha.0` to npm, then ran
`npx membook@alpha init` — first time anyone has experienced Membook as a
user rather than as its author.

**What the tool did.** Worked. The binary linked, the workspace-protocol fix
held, dependencies resolved from the registry. Run inside this repo it took
the idempotent path and left everything alone; run in a brand-new project it
created `.membook/memories/`, wrote the gitignore rules, and emitted
`MEMBOOK.md`.

The unplanned result was better than the intended one. Running it here
regenerated `MEMBOOK.md` and produced **no diff at all** — a package
installed from npm produced byte-identical output to the local build. The
determinism invariant, proven across two separate installations of the tool
without anyone setting out to test that.

**What annoyed me.** Two things, both cosmetic and both real.

`npx` prints `npm warn deprecated prebuild-install@7.1.3: No longer
maintained` before Membook says anything. It comes from `better-sqlite3` and
we cannot fix it, but it is the first line a new user reads, and it says
"unmaintained" about software they just installed.

npm also set `latest` on every package despite `--tag alpha`, because npm
forces `latest` on a package's first publish regardless of the tag. So
`npm install membook` now installs the alpha, which is exactly what the alpha
strategy was meant to prevent. Left as-is — the version string says
`alpha`, nobody knows the package exists, and the first real `0.1.0` will
overwrite it — but the lesson is that `--tag` does not protect a first
publish.

### 2026-07-24 — the clock starts

Registered the MCP server at user scope, pointing at the local build:

```
claude mcp add membook --scope user \
  -e MEMBOOK_AGENT=claude-code -e MEMBOOK_MODEL=claude-opus-4-8 \
  -- node <repo>/packages/mcp/dist/cli.js
```

Publishing is not a prerequisite for any of this. Four of the five gate
criteria — signature demo, hit rate, staleness catch, zero secrets — take
their evidence from ordinary use, and only cold `npx membook init` on a clean
machine actually needs the npm release.

Verified against an unrelated throwaway repo rather than this one: `remember`
anchored to `src/api.ts` at HEAD, `recall` returned it. First run as a general
tool rather than on its own source.

**Two weeks from today.**

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

### 2026-07-24 — the floor read: the re-checker rubber-stamped

**What happened.** Twelve failed re-checks against a local Ollama, all
attributed to `gpt-4o-mini`, because the model override existed only as
`MEMBOOK_MODEL` and nothing surfaced its name. Added `--model`, then ran
`verify --recheck --model qwen2.5-coder:3b` against the three known-true
memories.

**What the tool did.** 3/3 `restore` — **ungrounded**. The verdicts matched
ground truth, but only because we deliberately chose known-true memories for
the experiment. That is a property of the test set, not evidence of
competence. Read the reasons the prompt demanded:

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

### 2026-07-24 — grounding the restore

**What happened.** The floor read above was the rubber-stamp outcome, not the
near-miss it first looked like. Verdict accuracy was never the metric: a model
that restores for bad reasons will restore _false_ memories for bad reasons
too, and our test set was known-true, so 3/3 measured the test set rather than
the checker.

**What changed.** A restore now has to cite evidence, and the citation is
checked. The model returns a verbatim `evidence` quote from the anchored file;
Membook string-matches it against the file at HEAD before accepting. An
unmatched quote is a non-answer — the memory stays stale and the event is
logged `reason_grounded: false`.

This is the product's own move turned on its own re-checker: verify the claim
against reality rather than trust the claim. It is deterministic,
model-agnostic, and it fails in the safe direction — a rubber-stamping model
can no longer restore, only fail to restore.

The number worth publishing is therefore **grounded-restore rate**, not naive
verdict accuracy, which would have scored this checker 100%.

**Still pending.** The frontier read. It now discriminates cleanly: a model
that cites real code restores; one that produces plausible prose cannot. That
is a better experiment than the one it replaces.

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
