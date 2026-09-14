import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURES, fixtureAvailable, okAnalysis } from "../test-support/fixtures.js";
import { EXIT_DESCRIPTIONS } from "./cli-args.js";

/**
 * The README states figures the analysis produces, and prose does not fail when one moves. So the
 * figures it spells out are read back and compared against the code or a run. This does not check
 * the README's reasoning, only that a number in it is the number the tool reports, which is the
 * half that goes stale on its own.
 */
const README = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
  "utf8",
);

/** The README spells its small figures, so the comparison has to as well. */
const SPELLED: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
};

/** A misspelled word fails rather than parsing as nothing, which is why the map is explicit. */
function spelled(word: string | undefined): number | undefined {
  if (word === undefined) return undefined;
  if (/^\d+$/.test(word)) return Number(word);
  return SPELLED[word.toLowerCase()];
}

const AVAILABLE = FIXTURES.filter(fixtureAvailable);

describe("the figures the README states about constraints", () => {
  const total = spelled(/\*\*(\w+) are checked today\.\*\*/.exec(README)?.[1]);

  it.skipIf(AVAILABLE.length === 0)(
    "should say how many documented constraints are checked, and be right",
    () => {
      expect(total, "the README no longer states how many constraints are checked").toBeDefined();
      // A project checks fewer where something could not be read, so the figure is the most any
      // fully readable project reaches.
      const checked = AVAILABLE.map((fixture) => okAnalysis(fixture).result.constraintsChecked);
      expect(Math.max(...checked)).toBe(total);
    },
  );

  it("should break the checks into groups that sum to the figure it states", () => {
    const defaults = spelled(
      /\*\*(\w+) read what the installed Next\.js applies/.exec(README)?.[1],
    );
    const configuration = spelled(
      /\*\*(\w+) read your configuration against the rest of your project\*\*/.exec(README)?.[1],
    );
    const versioned = spelled(/The last (\w+) need the versions in play/.exec(README)?.[1]);
    for (const part of [total, defaults, configuration, versioned]) expect(part).toBeDefined();
    expect((defaults ?? 0) + (configuration ?? 0) + (versioned ?? 0)).toBe(total);
  });
});

describe("the exit statuses the README lists", () => {
  it("should list every exit status the CLI can return, and no other", () => {
    const table = /\| exit \| meaning \|\n\|[^\n]*\|\n((?:\|[^\n]*\|\n)+)/.exec(README)?.[1];
    expect(table, "the README no longer holds a table of exit statuses").toBeDefined();
    const documented = [...(table ?? "").matchAll(/^\| `(\d+)` \|/gm)].map((row) => Number(row[1]));
    expect(documented.sort()).toEqual(EXIT_DESCRIPTIONS.map((entry) => entry.status).sort());
  });
});
