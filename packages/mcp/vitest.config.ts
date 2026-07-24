import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Resolve workspace packages to source, so a fresh clone needs no build. */
export default defineConfig({
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
