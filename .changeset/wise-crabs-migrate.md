---
"@membook/spec": minor
"@membook/core": minor
"membook": minor
---

The write half of the memfile version machinery, landed before v2 needs it.

`parseMemfile` now reports the version a file declared on disk (`Memfile.version`) — after read-widening, the only remaining trace of what the file actually said. `membook status` counts the version spread of the store, and the new `membook migrate` rewrites every memory to the current canonical form in one pass a human reviews and commits: older versions come forward, hand-drifted files return to canonical serialization, and files from a newer Membook are skipped rather than downgraded. Nothing rewrites a committed file as a side effect of having read it.
