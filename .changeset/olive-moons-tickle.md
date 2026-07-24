---
"@membook/core": minor
---

Add the boot pack generator: `compileBook` and `writeBook` emit `MEMBOOK.md` at
the repository root.

Selection is greedy on expected-value-per-token under a hard 2,000-token cap.
Status weights rather than gates — a young book is honestly all-unverified, so
gating on `verified` would emit an empty book for exactly the repositories that
most need one — while stale and invalidated memories are excluded outright,
since the book is asserted with no room to caveat.

Output is byte-identical for identical book state, because the file is
committed and prepended to every session: unstable ordering would mean noisy
diffs on a file nobody edited and a prompt-cache miss on every start.
