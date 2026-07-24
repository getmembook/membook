import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Resolve `@membook/spec` to its SOURCE during tests.
 *
 * The package's `exports` point at `dist/`, which is correct for consumers
 * but means a fresh clone cannot run `pnpm test` until something has been
 * built — a contributor's first command failing on a resolution error is a
 * bad first five minutes, and CI passing only because `build` happens to run
 * first is luck rather than design.
 *
 * Aliasing here (rather than pointing `exports` at source and rewriting it
 * on publish) keeps the published package unambiguous: if it ever shipped
 * source-pointing exports, every consumer would break.
 */
export default defineConfig({
  // 15s, not the 5s default. These suites spawn real git repositories per
  // test, and Windows CI runners do that slowly enough that book.test.ts
  // timed out at 5s and its cleanup cascaded into ENOTEMPTY noise. A passing
  // test is no slower for the headroom; only a hung one waits longer.
  test: {
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@membook/spec": fileURLToPath(
        new URL("../spec/src/index.ts", import.meta.url),
      ),
    },
  },
});
