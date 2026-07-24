# Re-check Prompt — v1

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
 "reason": "one sentence citing the specific code or change that decided it"}

The reason must cite evidence, not restate the verdict.
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
