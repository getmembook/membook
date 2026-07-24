import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Resolve workspace packages to source, so a fresh clone needs no build. */
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
        new URL("../spec/src/index.ts", import.meta.url)
      ),
      "@membook/core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url)
      ),
    },
  },
});
