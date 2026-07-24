## What and why

<!-- What changed, and why. The diff shows what; it cannot show what you ruled
     out. If you rejected an alternative approach, say so and why. -->

## Related issue

<!-- Fixes #123. For anything non-trivial, please open an issue first. -->

## Checklist

- [ ] `pnpm build && pnpm typecheck && pnpm test` passes
- [ ] Tests added or updated (if fixing a bug, the test that would have caught it)
- [ ] No `INVARIANT:` test was weakened — if a change breaks one, the change is
      wrong, not the test
- [ ] Conventional commit messages (`feat:`, `fix:`, `docs:`, …)
- [ ] Changeset added if a published package changed (`pnpm changeset`)
- [ ] No new runtime dependency, or it is justified above (install weight is a feature)
- [ ] No network telemetry added
