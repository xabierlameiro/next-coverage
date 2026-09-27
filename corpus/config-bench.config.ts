import { defineConfig } from "vitest/config";

/**
 * Drives `config-bench.ts`, which the root config must not collect.
 *
 * No `globalSetup`: the root config builds `dist/cli.js` before any worker starts, and the bench
 * imports the reader from source and never runs the binary. Skipping the build is most of the
 * wall clock — around 40s of a 40s job.
 */
export default defineConfig({
  test: {
    root: new URL("..", import.meta.url).pathname,
    include: ["corpus/config-bench.ts"],
    testTimeout: 120_000,
  },
});
