# Dogfood log

Two weeks of ordinary work with Membook running on a real repository. Plain
entries: what happened, what the tool did, what annoyed you.

The annoyances are the point. They are v0.2's backlog arriving in order of
truth rather than in order of what seemed clever to build.

## The release gate

v0.1 does not ship until all five hold, on this log's evidence:

- [x] Cold `npx membook init` works on a clean machine — 2026-07-24
- [x] The signature demo runs unrehearsed — 2026-07-24/25. Release-day work
      nobody staged drifted four memories; `status` said so; the book withheld
      them and said why. Rename-following proven live (`docs/roadmap.md` →
      `docs/product-roadmap.md`, anchor rewritten) and 41/41 in the history
      backtest across three real repos.
- [x] Instrumentation shows a non-zero recall hit rate — 2026-07-25. 2 of 4
      logged recalls served ≥1 memory, including the first live hook
      injection: the pnpm-publish gotcha, served into a real session's
      context, anchors attached.
- [x] At least one genuine staleness catch, on work nobody staged for it —
      2026-07-24, twice: `m-d394` at 14:22 and `m-83be`/`m-9c90` at 19:17,
      all from ordinary release-day commits.
- [x] Zero secrets ever written — held to date, and this one never closes:
      it is a standing invariant, not a milestone. Evidence so far: one
      `write_blocked` at the scanner, two full-history gitleaks scans clean
      (including post-rewrite), query redaction live, and one credential a
      *harness* tried to print was caught by the same scanner.

All five held before anyone declared them: `0.1.0` shipped on the release
pipeline the day the last four closed, which is the right order of events
even though nobody planned it — the gates were closed by accumulated
evidence, not by wanting to ship.

## Also measure, for v0.2

Free to collect while the clock runs, expensive to discover afterwards.

- [x] **Merge style of every producer repo in the Stag workspace.** Measured
      2026-07-25, across eleven repos and ~700 commits: squash merges are
      **~1%** of history in the target workspace (8 commits total, all in the
      two big client repos). Direct commits dominate everywhere; where PRs
      exist they are merge commits, which preserve the original SHAs that
      anchors point at. The one squash-heavy repo in the sample is
      **membook itself** (17/52, 33%) — GitHub-flow OSS style. Ruling recorded
      in [v0.2-workspaces.md](design/v0.2-workspaces.md) §11: the blob-hash
      hedge is **deferred for the workspace federation** and revisits when
      cross-repo anchoring meets squash-flow repos in the wild.

Evidence lives in `.membook/telemetry/events.jsonl`, which is local and
gitignored. Paste the relevant lines into an entry rather than committing it.

## Entries

### 2026-07-24 — the intervention failed, and it is the finding that matters

**What happened.** Fixed the write-trigger problem three ways — `remember`'s
description now says _when_ to call it, `session_digest` gained triggers at
both ends of a session, and `init` writes a marked pointer into `CLAUDE.md`.
Then ran a real task in `backend-repo` with all of it live.

**What the tool did.** Nothing. Zero tool calls. The telemetry directory was
never created.

This was not a misconfiguration. Verified at the time: the MCP server reported
`✔ Connected`; a fresh connection was confirmed to receive the new
`as soon as you work out something` trigger; the pointer was present in
`CLAUDE.md`. The agent had the tools, the instruction, and the trigger, and
reached for none of them.

**The finding.** **Making a tool available is not the same as getting it
used.** A tool description is passive — it is read once the model is already
deciding to call something. Nothing in an ordinary session creates a moment
where _not_ using Membook costs anything, so nothing happens. Writing better
prose is not the lever, and we should stop reaching for it.

Two harder points fall out of this.

The **zero-integration assumption is wrong** in a way that matters. `MEMBOOK.md`
at the repo root was designed so agents _without_ Membook still benefit. But an
agent _with_ Membook fully installed did not use it either, so the problem is
not distribution — it is that nothing pulls.

And it **undercuts the thesis from the write side**. Verification is the moat,
but verification only operates on memories that exist. A perfect verification
loop over an empty book is worth nothing, and today's evidence is that books
stay empty by default.

**What annoyed me.** That the earlier session, before any of this work, _did_
call `recall` once. So the intervention did not obviously help and may have
been aimed at the wrong thing entirely.

**Next, and it is a change in kind rather than degree.** Stop persuading the
model and give the harness a forcing function: hooks. `SessionStart` injects
the book so knowledge arrives without being chosen; `UserPromptSubmit` can
inject relevant recall so retrieval needs no decision at all; `Stop` asks what
was learned. The cost is honest — hooks are Claude Code-specific, so this is
no longer zero-integration and does not port to Cursor or Codex. That tension
needs a ruling before it is built.

### 2026-07-24 — first outside repo: recall fired, remember never did

**What happened.** Set Membook up across nine real repos in the client workspace
and ran one ordinary session in `backend-repo`.

**What the tool did.** The whole telemetry file, preserved here before the
store was wiped for a clean re-run:

```json
{
  "at": "2026-07-24T15:21:30Z",
  "event": "recall",
  "query_terms": 3,
  "served": 0,
  "withheld_below_floor": 0,
  "withheld_by_status": {},
  "top_score": null,
  "context_paths": 0
}
```

One recall. Zero remembers. For contrast, this repo over the same day: 2
recall, 7 remember — and every one of those seven exists because someone
deliberately wrote it.

**The finding.** `recall` has a natural pull — "I need to know something".
Nothing in a session prompts "you just learned something, write it down", so
the book stays empty, recall keeps returning nothing, and the agent stops
asking. The failure compounds: that single recall could have been the last
one. `init` set up storage and left the hardest part — knowing _when_ — to
whoever remembered to write it by hand.

**What annoyed me.** Two things. The instruction had to be written by a human
into `CLAUDE.md`, which across nine repos is where "just paste this" stops
happening — the integration burden `init` exists to remove. And the log said
`query_terms: 3` without the query, so it could not answer the one question it
exists for: would a memory have helped?

Both fixed. Descriptions now say _when_; `init` writes one marked line; the
query is recorded, redacted through the secret scanner.

**Not yet proven.** None of that demonstrates agents will write more. The
baseline above is the "before"; the next session in `backend-repo` is the
"after".

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

### 2026-07-24 — a full loop on a second repo, and two null sinks

Ran every v0.1 surface end-to-end on `agent-first-ms` — a small, docs-only
repo, chosen because it can be broken freely. Worth naming that it has no
source files: the mechanics exercise fully, but "an agent reasoning about
code" does not, so this is a functional bed, not an adoption one.

Everything in the middle of the loop held. Both write paths recorded; the
uncommitted-anchor guard and the secret scanner both refused; untouched
anchors re-verified free; editing an anchored file flipped it to stale;
`git mv` was followed via `--follow` and the anchor path was rewritten to the
new name rather than lost; deleting the file invalidated it; the book withheld
the drifted memories and said so in its header; `review` ratified; and
`MEMBOOK.md` came back **byte-identical** after deleting the index and
reindexing.

The finding was in the observability, not the loop. Two of the five
`new Membook()` sites in the CLI were constructed without instrumentation, so:

- **`book` never logged.** `writeBook()` builds its event faithfully and hands
  it to a `NullInstrumentation`. Carried, withheld, excluded and token count —
  precisely the numbers the honesty claim rests on — were discarded on every
  human run. The log said the book had never been compiled.
- **`review` never logged at all.** It writes `status: verified` through the
  store directly. A human ratification is the only **ground truth** in the
  system; every other signal is a machine's opinion. Re-check accuracy is
  computable exactly to the extent these labels exist — and there were none.

Both fixed, with tests that read the log **file** rather than a spy, because
the defect was an event constructed correctly and dropped: a spy injected by
the test would have passed.

One consequence documented rather than engineered away: ratifying rewrites the
file, so it also emits a `remember` event. Write counts must be taken over
distinct ids.

**Also noted, not fixed.** There is no `recall` on the CLI — `init status
verify review reindex book remember`. Retrieval is MCP-only, so a human cannot
inspect what their agent would be served, and retrieval precision is the
binding constraint. Left as a recommendation rather than a silent addition.

**Method note.** One check in this run was a false pass: a determinism test
hashed `membook recall` output before and after a rebuild and reported
identical. Both sides were the same `unknown command` error. Re-run against
`MEMBOOK.md` bytes, which passes for real. A test whose subject does not exist
still returns green.

### 2026-07-24 — closing the volition gap, and a scoring bug it exposed

Four things landed: `membook recall` on the CLI, `membook seed`, `membook
distill`, and an opt-in `init --hooks`. Together they attack the one problem
measurement kept returning: the loop has a working middle and two ends that
depend on an agent choosing to act.

**`recall` on the CLI.** Retrieval precision is the binding constraint and was
unobservable without an agent volunteering to ask. It goes through `recall`,
not `search`, on purpose — a raw index query would show a friendlier result
than the one an agent actually gets, which is the self-deception the command
exists to prevent.

**`seed`.** Distills `CLAUDE.md`, ADRs and design docs into candidates, so the
book is useful before any agent has cooperated once. Everything is written
`unverified` and goes to `review`, which is also where the product gets the
only ground-truth labels it will ever have. First live run on a 3B: 4 kept, **3
discarded for citing files that do not exist** — the grounding gate earning its
keep immediately.

**`distill`.** The write side. `remember` asks an agent to notice it learned
something, judge it durable, phrase it, and pick anchors — four judgements at
the moment it is trying to finish. Distillation moves the bar to "say what
happened". On real session notes the 3B correctly ignored all the narration
(build runs, a typo fix, reading a file) and caught one of two real gotchas,
stating it slightly backwards, and missed the dead end — which was the best
memory in the notes. Machinery sound, small-model judgement weak, consistent
with every previous read.

Both prompts live in `prompts/` and a test asserts the shipped constant is
character-identical to the reviewed markdown. Without that, "versioned and
reviewed like code" describes a file nothing reads.

#### The scoring bug

Building the hook surfaced something the whole product had been carrying.

The hook injected a memory about auth tokens in response to `write me a haiku
about kubernetes`. Probing the scorer against one memory:

| query                                   | before | after      |
| --------------------------------------- | ------ | ---------- |
| `auth token refresh boundary timer`     | 1.2496 | 0.9996     |
| `why do auth tokens refresh oddly here` | 0.5355 | **0.9372** |
| `write me a haiku about kubernetes`     | 0.2499 | **0.0000** |
| `what is the weather today`             | 0.2499 | **0.0000** |
| `refactor the css grid layout`          | 0.2499 | **0.0000** |

Three unrelated queries scoring **identically** was the tell. Two causes:

1. **Coverage matched substrings, not words.** `ok` ⊂ `tokens`, `time` ⊂
   `timer`, `bound` ⊂ `boundary`. Every query collected phantom coverage.
2. **Stopwords counted.** Coverage is a ratio, so a memory matching only `the`
   in a five-word question scored the same 20% as one matching a rare term.

Note the second row: a genuine match went **up**, 0.54 → 0.94, because
stopwords no longer dilute the denominator. This was never a hook bug. It was a
precision bug in the thing the architecture calls the binding constraint, and
it was invisible because **the relative floor hides it** — the best of several
bad hits still wins, so a bad set always produced an answer.

Hence the second fix: an **absolute** floor (`RANKING.pushFloor`) alongside the
relative one. The relative floor answers "which of these is best"; it cannot
answer "is any of these good enough", because the top hit always clears a
fraction of itself. That distinction does not matter when an agent asked and
can discard the answer. It matters enormously for anything injecting context
unasked, where the reader cannot tell where a line came from.

**The general lesson.** A pull surface can tolerate a relative floor forever;
the error is masked by the user's ability to ignore it. Adding a push surface
is what forces an absolute judgement of quality — and it audited a scorer that
had passed 400 tests.

#### Hooks, and why they stay opt-in

`init --hooks` writes a `UserPromptSubmit` hook into `.claude/settings.json`,
merging rather than clobbering and refusing outright to rewrite a file it
cannot parse. It is off by default: hooks are Claude Code-specific and
zero-integration portability through `MEMBOOK.md` is a deliberate, marketed
property, so the portable path stays primary and this is an accelerant for the
one harness where the effect can be measured.

The hook never injects a stale memory, caps at three, and — the
non-negotiable — exits 0 silently on every failure. A memory tool that can
wedge someone's editor is not a memory tool.

**Still unmeasured.** Whether any of this moves the number. The next real
session in a seeded repository with hooks on is the experiment; until then this
is a better-designed guess.

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

### 2026-07-24 — the model's first live invalidate destroyed a true memory

**What happened.** Ran `verify --recheck` on this repo's own store after the
release-day churn — 4 genuinely stale memories, real drift. Two results.

The grounded-restore defense worked in the wild: the 3B tried to restore
`m-d394` citing "evidence" that was actually a file path, the string-match
rejected it, and the memory stayed stale. The defense built against
rubber-stamping caught a rubber-stamp on its first live attempt.

And the model invalidated `m-cbc0` — "publish with pnpm, never npm" — with the
reason "no longer true with the updated package.json." The memory is still
true. All that changed in the anchored file was the version number, bumped by
the release. A weak model destroyed a true memory over an irrelevant diff.

**The finding.** `restore` requires verbatim grounded evidence precisely so a
rubber-stamp cannot launder falsehoods into `verified`. `invalidate` had no
guard at all — taken on the model's bare word. Same failure mode, opposite
direction, and arguably worse: a false restore asserts one wrong thing, a
false invalidate silently deletes a true thing from the book, and nothing in
the product would ever mention it again unless a human happened to open
`review`.

**The fix.** A model may fail to restore; it may not destroy. Model
`invalidate` verdicts now land as `stale` — withheld, flagged, recoverable.
`invalidated` is reachable only through deterministic evidence (the anchored
file is gone) or a human decision in `review`. The verdict token is still
logged, so the gap between what models *want* to destroy and what deserves
destroying is itself now a measurable number.

**Worth noting.** Every layer of this came from dogfooding on real drift:
fixture tests passed throughout, the calibration harness had even blessed
model-invalidates as acceptable. The policy was wrong, not the code, and only
live data could say so.

### 2026-07-25 — the half-life is a property of the repo, not of software

**What happened.** Extended the backtest beyond the first three repos: five
more local repos plus one external OSS library (`execa`, 563 commits walked
across 6.7 years). Also fixed a harness crash the extension exposed — membook
was the first target that already carries its own memories, and the verify
pass returned verdicts on ids the harness never planted.

**The numbers.**

| repo | commits walked | window | median drift | half-life |
| --- | --- | --- | --- | --- |
| backend-repo | 175 | 35d | 14.7d | 21.9d |
| frontend-repo | 115 | 35d | 13.8d | 35.8d |
| device-repo | 39 | 35d | 15.2d | 15.3d |
| execa (mature OSS) | 563 | 2447d | **419.6d** | **419.6d** |
| membook (2 days old) | 34 | <1d | — | degenerate |
| two sparse websites | 13–14 | 36–90d | — | degenerate |
| two docs-only repos | — | — | — | n/a (no code) |

**The finding.** The 13.8–15.2-day cluster was real but LOCAL: three repos in
the same regime — early-stage, high-activity product code. Outside that
regime the number moves by an order of magnitude in both directions: a mature
library holds anchors for ~14 months; a two-day-old repo or a sparse website
gives degenerate answers because the metric needs commit density to mean
anything.

So the honest claim is not "memory half-life is two weeks." It is: **half-life
is a measurable property of each repository's activity regime**, ranging from
weeks on active product code to over a year on settled libraries. That is a
better product story than the constant would have been — a fixed re-check
cadence would be wrong almost everywhere, and Membook's session-time
verification adapts to the repo's own tempo for free. The backtest is the
instrument that tells a team where their repo sits.

**Harness lesson.** A target with a live memory store crashed the
bookkeeping — verdicts arrived for memories the harness never seeded. Fixed
by scoping drift accounting to planted ids. Every new class of target has
found a new assumption; this one found the assumption that the harness owns
the store.
