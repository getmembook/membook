# Re-check Prompt — v2

> **v2 (2026-07-24): a restore must cite evidence, and the citation is
> checked.** The first live re-check returned three restores whose reasons
> cited a different memory's subject, argued for caution, and were factually
> wrong. The verdicts matched ground truth only because the memories happened
> to be true — a model that restores for bad reasons will restore _false_
> memories for bad reasons too. Prose alone cannot be trusted, so a restore
> now requires a verbatim `evidence` quote which is string-matched against the
> anchored file. Unmatched evidence is a non-answer: the memory stays stale
> and the verdict is logged `reason_grounded: false`.

> This file is versioned and reviewed like code. It is the model-facing prompt
> used when a memory's anchored code has changed and something must decide
> whether the memory still holds. Changing it changes product behaviour and
> carries the same review bar as a code change.

## Posture: skeptic, not judge

The re-checker's dangerous failure is the **false restore** — laundering a
stale memory into a verified one. A re-checker that rubber-stamps is worse
than no re-checker at all, because `verified` is a claim users act on.

Therefore:

- **`still-stale` is the default.** It is what you return when the evidence
  does not clearly settle the question.
- **Restoration requires affirmative evidence** in the diff or the current
  code that the statement is still true.
- Uncertainty is not a tie to be broken. It is a `still-stale`.

## Prompt

```
You are checking whether a recorded project memory is still true after the code
it describes has changed.

MEMORY (recorded {{created}}, last verified {{verified}}):
{{statement}}

IT IS ANCHORED TO:
{{anchors}}

WHAT CHANGED in those files since it was last verified:
{{diff}}

CURRENT CONTENT of the anchored regions:
{{current}}

Decide one of:

- "restore"     — the code at HEAD still makes this statement true. Only choose
                  this when you can point to specific current code that
                  supports it. Absence of contradiction is NOT support.
- "still-stale" — you cannot confirm it from the evidence, or the change is
                  ambiguous, or the statement is partially outdated. This is
                  the correct answer whenever you are unsure.
- "invalidate"  — the code now contradicts the statement, or the thing it
                  describes no longer exists.

Reply with JSON only:
{"verdict": "restore" | "still-stale" | "invalidate",
 "reason": "one sentence",
 "evidence": "verbatim quote from the CURRENT code — required to restore"}

The evidence must be copied verbatim from the CURRENT code shown above. It is
string-matched against the file: a quote that does not appear there rejects
the restore. Do not paraphrase, and do not quote the memory back — quote the
code.
```

## Repair prompt

Sent once when the first reply fails schema validation:

```
Your previous reply was not valid JSON matching the required shape.
Reply with ONLY this JSON object and nothing else:
{"verdict": "restore" | "still-stale" | "invalidate", "reason": "<one sentence>"}
```

## After a failed repair

Do not retry again, and do not guess. Return `still-stale` with a reason
recording that the provider could not be parsed, and log it. A memory left
stale costs a re-check next pass; a memory wrongly restored costs the user's
trust in every other memory.
