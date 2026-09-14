import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Builds dist/cli.js before any worker starts; two tests run the binary, not the source.
    globalSetup: ["./test-support/build-cli.ts"],
    // Fixture tests analyse real projects of thousands of files. The default 5s is a
    // timeout on the machine, not on the code, and it hides real failures behind noise.
    //
    // 60s rather than 30s because load on the machine running it can vary several times over
    // — `tsup` alone can run from 1.7s to 7s untouched — and a run that slow can pass a
    // ceiling written for a quiet one. A suite that takes 12-14s has nothing to lose to a
    // limit it never approaches; what it loses to a limit set too low is a real failure
    // reported as a timeout.
    testTimeout: 60_000,
    // A copy of this repository nested under a dot-directory, such as a worktree, would otherwise
    // be collected too: the suite then runs twice, once per copy, and every count the CI checks is
    // doubled by something that is not the project. `.fixtures/` holds the pinned projects.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.*/**"],
  },
});
