---
"@membook/core": minor
"membook": minor
---

Workspace verification: contract-watch across repositories, and the third epistemic state.

The verify pass gains its working-tree parameter — it was always a pure function of `(anchor, checkout)`, and now an `xgit` anchor runs the unchanged diff, rename-follow and transition logic inside the resolved member's checkout, advancing to that repository's HEAD when it proves out. A member this machine cannot use yields `unresolvable`: not stale (nothing is known to have changed), not verified (nothing was checked), never folded into either. An unresolvable anchor blocks confirmation but not conviction — a deleted or drifted local anchor still demotes — and the boot pack withholds unresolvable-anchored memories under their own honest count, separate from drifted. `membook verify --workspace [manifest]` wires it up; without a workspace, cross-repo anchors are reported as unreachable with the member named, not treated as errors. The fixture harness grows a multi-repo `workspaceFixture`, and the v0.2 signature demo — producer edits the contract, consumer's memory flips stale before an agent writes code against the old shape — runs as an automated test, including the producer-rename case.
