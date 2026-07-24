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

## Current state of secret scanning

Membook's design commitment is that **no secret ever reaches a committed memory
file**, enforced by scanning every distillation output before anything is
written under `.membook/`.

**That scanner is not implemented yet.** It is build step 6 and is
launch-blocking — v0.1 will not ship without it.

What exists today is the seam it plugs into: every write passes through a
configured `WriteGuard` before touching disk, and a guard returning findings
blocks the write entirely. The default is `NoopWriteGuard`, which passes
everything and is named to be honest about that.

Until the scanner lands, **treat any content you pass to Membook as content you
are choosing to commit**. Do not point it at transcripts containing live
credentials.

This section will be updated when step 6 ships. If you find it out of date with
the code, that is itself worth reporting.

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
