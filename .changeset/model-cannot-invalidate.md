---
"@membook/core": patch
---

A model may fail to restore, but it may not destroy. LLM re-check `invalidate`
verdicts now land as `stale` — withheld from the book, flagged for review,
recoverable — instead of invalidating the memory outright. `invalidated`
remains reachable only through deterministic evidence (the anchored file is
gone) or a human decision in `review`. Measured on live data: a small model
invalidated a still-true memory because a version number changed in its
anchored file; `restore` requires string-matched evidence precisely to stop
rubber-stamping, and this closes the same hole in the destructive direction.
