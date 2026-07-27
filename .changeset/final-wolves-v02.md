---
"@membook/core": minor
"membook": minor
"@membook/mcp": minor
---

v0.2 completes: workspace surfaces, federated recall, and the boot context.

`--workspace` reaches every remaining surface. `status -w` reports each member's resolution — identity confirmed, unconfirmed, or undeclared as three different facts — plus how many memories reach into it and how far it lags its upstream (information, never alarm, never a fetch). `book -w` admits cross-repo memories only when their repositories are present. The MCP server takes `MEMBOOK_WORKSPACE`.

Federated recall lands under the hard rule: Membook never writes inside a checkout it did not init. Neighbour indexes build in `~/.membook/workspace-cache/<member>/`, keyed by indexed HEAD and rebuilt when it moves — same index code, same ranking, different location. Cross-repo hits carry `from <member>` provenance everywhere they are served, a remote hit never outranks an equally relevant local one, and the modifier cannot rescue a floor failure.

`session_digest` gains the workspace context: what the neighbours know about this repository — cross-repo memories anchored into it — served live, capped, counted, and never committed; the book stays sovereign to its own store.
