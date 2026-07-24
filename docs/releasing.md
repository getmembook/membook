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

## Not automated yet

There is **no release workflow**. `changeset` is configured and the root
`release` script exists, but nothing runs them: no version PR, no tagging, no
CI publish. Releases today are entirely manual, following this document.

When that workflow is written it must encode the two rules above — **pnpm, and
dependency order** — and will need a granular token with both settings as
`NPM_TOKEN`, because CI cannot answer an OTP prompt.
