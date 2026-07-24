# Contributing to Membook

Thanks for considering it. This project is MIT and intends to stay that way.

> **Pre-release.** The architecture is settled but the surface is still moving.
> Before starting anything substantial, please open an issue — it may already be
> scoped, deliberately deferred, or explicitly out of scope.

## Getting set up

Requires Node ≥ 20 and [pnpm](https://pnpm.io) 9. The repo pins Node 24 via
[mise](https://mise.jdx.dev) (`.mise.toml`) and `.nvmrc`.

```bash
pnpm install
```

```bash
pnpm test
```

Tests run from source, so a fresh clone needs no build step first. Before
pushing:

```bash
pnpm build && pnpm typecheck && pnpm test
```

## Repository layout

```
packages/spec/    @membook/spec — the Memfile standard. Zero dependencies on the rest.
packages/core/    @membook/core — engine: store, index, retrieve, verify, distill.
packages/mcp/     @membook/mcp — stdio MCP server wrapping core.
packages/cli/     membook — the CLI binary wrapping core.
docs/             concept and design documents
prompts/          versioned model-facing prompts (reviewed like code)
.membook/         this repo's own memories — we eat our own dog food
```

[CLAUDE.md](./CLAUDE.md) is the build context: architecture decisions, the v0.1
build order, and what is explicitly out of scope. Read it before proposing
design changes — several decisions are marked _do not relitigate_, and they
carry that label because they were settled with reasons written down.

## What we are looking for

Good contributions right now:

- Bug reports with a reproducing case
- Test cases that break an invariant we claim to hold
- Implementations of the Memfile format in other languages
- Documentation that corrects something inaccurate

Please **open an issue first** for new features, new runtime dependencies, or
anything touching the spec. Install weight is a feature: `npx membook init` has
to stay fast, so a new dependency needs a strong justification.

## The bar for changes

**Invariants are load-bearing.** Some tests are named `INVARIANT:` — byte-exact
round-tripping, deterministic rebuilds. If a change breaks one, the change is
wrong, not the test. If you believe an invariant itself is wrong, open an issue
and argue for it rather than editing the assertion.

**Failures must be loud.** Never silently skip a malformed memory. Quarantine
it, report it, and surface it in `status`. Errors carry actionable messages.

**Validate at the boundary.** Memories validate on read _and_ on write. Writes
go through the wire schema, so malformed state cannot reach disk.

**Determinism is not a nicety.** Memories live in git and get reviewed in pull
requests. Identical content must produce byte-identical files, and a rebuilt
index must retrieve identically.

**No network telemetry.** Instrumentation is local-file only. This is not
negotiable.

## Tests

Colocated as `*.test.ts` beside what they test, run with
[Vitest](https://vitest.dev).

Prefer tests that state a property rather than pinning an implementation
detail. A test asserting "every anchor serializes `kind` first" survives a
refactor; one asserting an exact byte offset does not.

If you fix a bug, add the test that would have caught it.

## Commits and pull requests

[Conventional commits](https://www.conventionalcommits.org): `feat:`, `fix:`,
`docs:`, `chore:`, `refactor:`, `test:`.

Keep pull requests small and single-purpose — we do this even working solo,
because the repo's own PR-reviewed memory workflow is the product's story.

Explain **why** in the commit body, not just what. The diff shows what changed;
it cannot show what you ruled out. Several of this repo's commit messages record
a rejected alternative and the reason — that is the standard.

Changes to published packages need a [changeset](https://github.com/changesets/changesets):

```bash
pnpm changeset
```

Publishing itself is documented in [docs/releasing.md](./docs/releasing.md).
Read it before releasing anything — there is no release workflow yet, and the
process has several traps that produce misleading errors, including one that
ships a package whose binary silently never links.

## Code style

Formatting is not hand-managed — match the surrounding file. TypeScript strict,
ESM only.

Comments should explain _why_, especially where the obvious approach was
rejected. Do not narrate what the code plainly does.

Vocabulary matters and is used consistently: **memory** (the record), **anchor**,
**book** (the compiled boot pack), **verify pass**, **distill**. Not "note",
"fact", or "knowledge item".

## Reporting security issues

Do not open a public issue. See [SECURITY.md](./SECURITY.md).

## Licensing

By contributing, you agree that your contributions are licensed under the MIT
License, consistent with the rest of the project.

## Signed commits

`main` requires signed commits. Sign with SSH — no GPG setup needed:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

Then register that key on GitHub as a **signing** key. This is a separate list
from your authentication keys, and skipping it is the usual reason commits show
as _Unverified_ while `git log --show-signature` says the signature is good:

```bash
gh auth refresh -h github.com -s admin:ssh_signing_key
gh ssh-key add ~/.ssh/id_ed25519.pub --type signing --title "commit signing"
```

## Project memory is live in this repo

This repository dogfoods its own product. `.claude/settings.json` carries a
`UserPromptSubmit` hook: if you work here with Claude Code, relevant project
memories are injected into your prompts automatically. It reads the local
build (`packages/cli/dist`), so it silently does nothing until you have run
`pnpm build` — and silently does nothing on any failure, by design.

Not using Claude Code, or not wanting the injection? Delete the file locally;
nothing else depends on it. Memories themselves live in `.membook/memories/`
and are reviewed in pull requests like any other change.
