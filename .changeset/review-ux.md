---
"membook": patch
---

`membook review` re-flows hard-wrapped memory bodies before display, and
re-asks on input it does not recognize instead of silently skipping — typed
`dd` meaning delete, the old behaviour printed "Skipped." and moved on, which
on a prompt with a destructive option is the worst way to be wrong. EOF still
quits, so piped input cannot loop.
