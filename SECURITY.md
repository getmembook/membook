# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security report.**

Report privately via a
[GitHub security advisory](https://github.com/getmembook/membook/security/advisories/new).

We aim to acknowledge reports within 72 hours.

We are especially interested in anything that could cause credentials, tokens,
or other secrets to be written into a Memfile or `MEMBOOK.md` — memories are
committed to the user's repository, so a leaked secret in a memory file is
persisted, pushed, and shared with everyone who clones.

## Supported versions

Pre-release. Only `main` is supported; nothing is published to npm yet.

## Secret scanning

Membook's commitment is that **no secret ever reaches a committed memory file**.
Every write passes through a scanner before anything touches `.membook/`, and a
match blocks the write entirely — nothing is partially written.

The scanner is **deny-biased**, because the two failure modes are not
comparable:

- A false positive blocks a memory. A human looks at it. Done.
- A false negative commits a credential, which is then pushed and cloned.

So when a rule is torn, it blocks. It covers AWS, GitHub, Slack, Stripe,
Google, OpenAI, Anthropic and npm credentials, private key blocks, JWTs,
connection strings with inline passwords, and high-entropy values assigned to
secret-shaped names. It scans the whole serialized memory, not just the
statement — a secret pasted into an anchor path is committed the same way.

Findings are **redacted** in error messages and logs: enough to locate the
secret, never enough to use it.

It is **on by default** in the MCP server, which is the surface agents actually
write through. A guard that had to be opted into would protect nobody.

### What it is not

Regex scanning is a floor, not a ceiling. It will not catch a credential that
looks like ordinary prose, or a bespoke internal token format. Do not treat a
passing scan as permission to paste secrets at Membook — the guarantee is that
we try hard to catch them, not that catching them is decidable.

If you find a credential class it misses, that is a security report.

## Scope

Membook is local-first and runs no daemon, no server, and no network
telemetry — so the meaningful attack surface is what gets written to disk and
committed:

- Secrets or personal data written into a memory file or `MEMBOOK.md`
- Path traversal via anchor paths escaping the repository
- Code execution through parsing untrusted memory files
- Anything causing memories to be silently altered, dropped, or misattributed —
  provenance and verification status are integrity claims, and a way to forge
  one is a vulnerability

Out of scope: vulnerabilities in the model providers Membook talks to, and
anything requiring an attacker who already has write access to your repository.

## Known dependency advisories

Both are audited and neither is reachable in how these packages are used. They
are listed here so nobody has to rediscover that, and so a change in either is
noticed rather than lost in the noise.

| Advisory | Severity | Status |
| --- | --- | --- |
| `@hono/node-server` path traversal, via `@modelcontextprotocol/sdk` | moderate | **Not reachable.** `@membook/mcp` connects over `StdioServerTransport` only; `@hono/node-server` backs the HTTP transports, which are never instantiated. No fix is available upstream — the current SDK release still depends on the affected range. |
| `esbuild` arbitrary file read, via `tsup` | low | **Not shipped.** Build-time only, and the issue affects esbuild's dev server, which nothing here runs. |

Re-check with `pnpm audit`. If either becomes reachable — an HTTP transport is
added, or esbuild moves onto the runtime path — it stops being acceptable and
must be fixed or the dependency dropped.
