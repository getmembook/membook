---
"@membook/spec": minor
"@membook/core": minor
---

The workspace manifest and resolver — step 1 of the v0.2 multi-repo sequence.

`@membook/spec` gains the workspace manifest schema (`workspace.yaml`: stable member names → checkouts), standard-surface because committed memories will reference the names it defines. `@membook/core` gains the resolver: per-member, non-fatal resolution with `~` expansion and meta-repo-relative paths, plus the normalized identity check — SSH and HTTPS forms of a repository are the same identity, a checkout with no origin resolves with its identity honestly unconfirmed, and the one loud refusal is a remote that exists and disagrees, because verifying against the wrong checkout would manufacture confident, wrong verdicts. Nothing consumes these yet; `xgit` anchors and `--workspace` build on them next.
