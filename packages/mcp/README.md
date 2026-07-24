# @membook/mcp

The Membook MCP server. Serves a repository's memories to any MCP-capable
coding agent over stdio.

**No daemon.** The server spawns on stdio per session and exits with it — no
ports, no resident process, no background state.

MIT © Stag.ai Ltd

## Setup

Claude Code:

```bash
claude mcp add membook -- npx -y @membook/mcp
```

Or configure it directly, in any MCP client:

```json
{
  "mcpServers": {
    "membook": {
      "command": "npx",
      "args": ["-y", "@membook/mcp"],
      "env": {
        "MEMBOOK_AGENT": "claude-code",
        "MEMBOOK_MODEL": "claude-opus-4-8"
      }
    }
  }
}
```

| Variable          | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `MEMBOOK_ROOT`    | Repository root. Defaults to the working directory. |
| `MEMBOOK_AGENT`   | Recorded in provenance, e.g. `claude-code`.         |
| `MEMBOOK_MODEL`   | Recorded in provenance, e.g. `claude-opus-4-8`.     |
| `MEMBOOK_SESSION` | Session id, recorded in provenance.                 |

## Tools

### `recall`

Searches memories, ranked by relevance, path proximity to the files being
worked on, recency, and verification status. **Capped at 8 results**, and
floored: weak matches are withheld rather than used as padding.

The cap and floor are the point. A memory that does not answer the question is
worse than no memory at all — contaminated context measurably inflates
per-step error rates, so retrieval biases toward returning less.

By default it returns `verified` and `unverified` memories and **withholds
`stale` ones** — those whose anchored code has changed since they were last
verified. Pass `include_stale` to see them; they arrive flagged.

When everything relevant is stale, the reply says so:

> No usable memories for that query. 2 matching memories are stale — the code
> they describe changed and they have not been re-verified.

That distinction carries the product. "We know nothing" and "we know something
we no longer trust" are different facts, and an agent that cannot tell them
apart will confidently re-derive a broken answer.

### `remember`

Records durable, project-specific knowledge: a decision and its reason, a
non-obvious gotcha, a convention, a map of where something lives, or a dead end
not worth retrying.

Every memory **must** name the files it is about. An unanchored memory cannot
be verified, so it is rejected rather than stored.

New memories are written `unverified` — nothing has checked them against the
code yet, and claiming otherwise would be the unfalsifiable assertion this
project exists to prevent. They become `verified` on the next verify pass.

### `session_digest`

Reports how many memories exist and how many are verified, stale, or
invalidated, plus anything quarantined for failing validation.

With `verify: true` it re-checks anchors against HEAD and reports what _would_
change — read-only, writing nothing.

## Programmatic use

```ts
import { createServer } from "@membook/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createServer({ root: process.cwd(), agent: "my-agent" });
await server.connect(new StdioServerTransport());
```

Nothing may be written to stdout: it _is_ the transport, so a stray
`console.log` corrupts the protocol stream. Diagnostics go to stderr.
