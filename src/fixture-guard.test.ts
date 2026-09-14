import { readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { describe, expect, it } from "vitest";

/**
 * `it.each` over a list filtered by fixture availability registers no tests when the filter empties
 * it, and a `describe` holding no tests is an error rather than a skip. The block then passes on a
 * machine holding the fixtures and fails on a clean clone — a failure mode that reached `main`
 * three times before `eachFixture` existed to take it away.
 *
 * The helper is the fix; this is what keeps the shape from coming back by hand. Written against the
 * text rather than the AST because the pattern is a spelling, and a spelling is what a reader
 * reaches for when writing the next one.
 */
describe("the shape that fails only on a clean clone", () => {
  const root = join(import.meta.dirname, "..");
  const forbidden = /it\.each\([^)]*\.filter\(\s*fixtureAvailable|it\.each\(present\(/;

  it("should find no filtered it.each left in the suite", async () => {
    const files = (
      await glob(["src/**/*.test.ts", "test-support/**/*.ts"], {
        cwd: root,
        ignore: ["**/node_modules/**", "**/.*/**"],
      })
    )
      // This file holds the shape on purpose, in the assertion below that proves the pattern
      // still matches it. Reading itself would make the guard fail for doing its job.
      .filter((file) => !file.endsWith("fixture-guard.test.ts"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) =>
      forbidden.test(readFileSync(join(root, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("should still recognise the shape it forbids", () => {
    // The guard is a regular expression, and one that matches nothing would pass this file
    // silently for as long as nobody wrote the mistake again.
    const written = "it.each(FIXTURES.filter(fixtureAvailable).map((f) => ({ f })))(";
    expect(forbidden.test(written)).toBe(true);
    // The same list filtered through a helper first, which reads differently and fails the same.
    expect(forbidden.test("it.each(present(FIXTURES))(")).toBe(true);
  });
});
