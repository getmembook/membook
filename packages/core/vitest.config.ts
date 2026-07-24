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
  resolve: {
    alias: {
      "@membook/spec": fileURLToPath(
        new URL("../spec/src/index.ts", import.meta.url),
      ),
    },
  },
});
