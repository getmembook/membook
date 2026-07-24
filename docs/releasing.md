# Releasing

How Membook gets published, and the things that will bite you if you improvise
it. Everything here was learned by doing it wrong first, on 2026-07-24.

## The one rule

**Publish with `pnpm`, never with `npm`.**

The packages depend on each other through pnpm's workspace protocol:

```json
"dependencies": { "@membook/core": "workspace:*" }
```

`pnpm` rewrites that to a real version when it packs. **`npm` does not.** A
tarball built by `npm pack` ships `"@membook/core": "workspace:*"` verbatim,
npm cannot resolve it, the install fails — and because the install failed,
`node_modules/.bin/membook` is never created. The symptom is not an error
about workspaces; it is `npx membook` doing nothing at all.

Verify rather than trust:

```bash
cd packages/cli && pnpm pack --pack-destination /tmp
tar -xzOf /tmp/membook-*.tgz package/package.json | grep '@membook'
```

Every `@membook/*` line must show a real version. If any says `workspace:*`,
stop.

## Dependency order

Publish in this order, because each depends on the ones before it:

```
@membook/spec  →  @membook/core  →  @membook/mcp  →  membook
```

`spec` has no internal dependencies. `core` needs `spec`. `mcp` and the CLI
need both. **If one fails, stop** — do not publish the rest. A package whose
dependency does not exist on the registry is unusable, and npm versions cannot
be reused after `unpublish`.

## Authentication

npm requires 2FA for publishing, and this interacts badly with pnpm.

**`pnpm publish` does not prompt for an OTP.** It fails with a 403 telling you
2FA is required. `npm publish` _does_ prompt. That leaves two working paths:

### Path A — a granular token (what CI will need)

Create a **Granular Access Token** at npmjs.com with **both** of:

- **Packages and scopes → All packages.** Not just the `@membook` scope.
  Scoped and unscoped names are different namespaces: a token scoped to
  `@membook` can publish `@membook/spec` but **cannot** publish the unscoped
  `membook`, and fails with a _different_ 403 (`You may not perform that
action with these credentials`) that looks unrelated.
- **Bypass two-factor authentication.** Without it you get the 2FA 403 even
  with correct scope.

Getting one of the two right produces a confusingly different error each time.
The two errors are diagnostic:

| Error                                                    | Meaning                                 |
| -------------------------------------------------------- | --------------------------------------- |
| `Two-factor authentication ... is required`              | token lacks 2FA bypass                  |
| `You may not perform that action with these credentials` | token lacks scope for that name         |
| `ENEEDAUTH` / `need auth`                                | no credentials at all — run `npm login` |

Then publish without ever writing the token to disk:

```bash
env 'npm_config_//registry.npmjs.org/:_authToken=TOKEN' \
  npm publish /tmp/mbpub/membook-spec-0.1.0.tgz --tag alpha --access public
```

### Path B — pack with pnpm, publish with npm

Gets pnpm's workspace rewriting _and_ npm's interactive OTP prompt:

```bash
pnpm build
for p in spec core mcp cli; do (cd packages/$p && pnpm pack --pack-destination /tmp/mbpub); done
npm publish /tmp/mbpub/membook-spec-*.tgz --tag alpha --access public
# ...then core, mcp, cli, in that order
```

Publishing a tarball uploads it byte-for-byte, so npm never gets a chance to
reintroduce the workspace bug.

## Dist-tags

**`--tag alpha` does not stop npm setting `latest`.** A package's _first_
publish always takes `latest`, whatever tag you pass. If the intent is that
`npm install <pkg>` should return nothing yet, a first publish cannot give you
that — plan for it rather than discovering it afterwards.

`latest` cannot be deleted, only repointed.

## Verifying a publish

**`npm view` lies for the first few minutes.** The public read API lags behind
a new package by minutes, so `npm view` and a direct registry `GET` both 404
while the package exists perfectly well.

The authoritative check is ownership, which reads a different path:

```bash
npm owner ls @membook/spec     # only succeeds for a package that exists
npm access get status @membook/spec
```

Do not republish because `npm view` 404s. Check ownership first.

## Name reservation

Owning the **npm organisation** `membook` reserves the entire `@membook/*`
scope — nobody else can publish `@membook/anything`. That protection does
**not** extend to the unscoped name `membook`, which is first-come,
first-served like any other.

So the scoped packages were never at risk; the unscoped CLI name was the only
genuinely exposed asset.

## Before you publish

```bash
pnpm build && pnpm typecheck && pnpm test
```

Then confirm the artefact actually works, rather than assuming:

```bash
cd packages/cli && pnpm pack --pack-destination /tmp
cd $(mktemp -d) && npm init -y && npm install /tmp/membook-*.tgz
ls node_modules/.bin/membook          # must exist
```

That last check is the one that catches the workspace-protocol bug. It is also
the only thing that would have caught it — the npm warning about `bin` is
misleading and fires even when `bin` is fine.

> **Historical note.** Everything above this line describes the manual process
> that shipped `0.1.0-alpha.0` from a laptop — kept because its traps (pnpm vs
> npm, dependency order, the first-publish `latest` tag) are real and were each
> hit once. Releases are now automated; the current process is below.

## Automated releases (CI)

Publishing runs from `.github/workflows/release.yml`, not a laptop. A release is
always a reviewed pull request:

1. Merge PRs to `main` as normal. Each carries one or more `.changeset/*.md`
   entries describing the change and its bump.
2. The release workflow sees the pending changesets and opens a
   **"chore: version packages"** PR that bumps versions and writes changelogs.
   Nothing is published yet.
3. Review that PR — it is the last chance to see exactly what versions ship —
   and merge it.
4. The workflow runs again, finds no changesets left, and **publishes**, in
   dependency order, with a provenance attestation on every tarball.

### Authentication: trusted publishing, no stored credential

There is **no npm token anywhere** — not in repo secrets, not on npmjs. Each of
the four packages has a **trusted publisher** configured on npmjs.com
(package → Settings → Trusted Publisher):

- Publisher: **GitHub Actions**
- Organization / repository: **getmembook / membook**
- Workflow filename: **`release.yml`**
- Environment name: **blank** — the workflow declares no `environment:`, and a
  mismatch here 403s
- Allowed actions: **npm publish**

At publish time the changesets action exchanges the job's OIDC identity
(`id-token: write`) for a short-lived credential. Nothing stored, nothing to
rotate, nothing to leak.

Two operational consequences:

- **The trust is bound to the workflow filename.** Renaming `release.yml`
  breaks publishing with an E403 until the trusted-publisher settings on all
  four packages are updated to the new name.
- **A new package must have its trusted publisher configured before its first
  CI publish**, or that one package 403s while the others go out. This exact
  partial publish happened on the first `0.1.0` run: three scoped packages were
  configured and shipped, the unscoped `membook` was not and failed. The fix
  was configuring it and re-running — `changeset publish` is idempotent and
  retried only the missing package.

For a one-off manual publish (emergency only): mint a granular token on npm at
that moment, use it once, revoke it. Do not park one in secrets — an unused
credential is pure liability, and if a token named `NPM_TOKEN` is present in
the environment the action will prefer it over OIDC, silently downgrading auth.

### Verifying a release

After publishing, every package page on npm should show a **"Provenance"**
section linking back to the exact commit and workflow run. Confirm with:

```bash
npm view membook dist.attestations   # should be present, not "none"
```

### The version PR and signed commits

`main` requires signed commits. The changesets action commits the version PR
through the GitHub API (`commitMode: github-api`), so those commits carry
GitHub's signature and verify — measured after the first release, whose
version PR was committed with plain git, arrived unsigned, and needed an
admin merge.

One quirk to expect: workflows do not run automatically on commits the action
makes with `GITHUB_TOKEN` (GitHub's recursion guard). The version PR sits with
no checks until a maintainer approves the run from the PR page; then CI runs
and it merges normally.
