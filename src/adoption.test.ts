import { describe, expect, it } from "vitest";
import { fixtureRoot } from "../test-support/corpus.js";
import { eachFixture, FIXTURES, fixtureAvailable, okAnalysis } from "../test-support/fixtures.js";
import { EXAMINATION_TRANCHES } from "./catalog/config.js";
import { readFlagPresence, readNextConfig } from "./collect/config.js";

describe("the configuration restating what Next.js already does", () => {
  const OPTIMIZE = "config/next-config-js/optimizePackageImports";

  eachFixture()(
    "should keep the entry in used on $fixture.name, because the project sets the option",
    ({ fixture }) => {
      const entry = okAnalysis(fixture).result.entries.find((e) => e.id === OPTIMIZE);
      // A finding about the contents is not a statement about adoption.
      if (entry) expect(["used", "not-evaluated"]).toContain(entry.bucket);
    },
  );
});

describe("the backlog the report states about itself", () => {
  eachFixture()(
    "should report no backlog on $fixture.name, having measured every candidate",
    ({ fixture }) => {
      // Counted over the whole catalog, not over the entries with no verdict: an entry the
      // project uses would otherwise hide its own backlog inside the used bucket, which is how
      // the README came to assert a zero the catalog never held.
      //
      // Zero here is earned rather than asserted: the six that stood were each measured and
      // produced nothing. A condition added without one fails this.
      expect(okAnalysis(fixture).result.unwrittenConditions).toBe(0);
    },
  );
});

describe("the options the examination looks at next", () => {
  const OPTION_PREFIX = "config/next-config-js/";

  /** The options a project sets, read the way the derived predicate reads them. */
  const configuredBy = (root: string): ReadonlySet<string> => {
    const config = readNextConfig(root);
    return new Set(
      EXAMINATION_TRANCHES.flat().filter((option) =>
        [option, `experimental.${option}`].some((path) => {
          const found = readFlagPresence(config, path);
          return found.status === "resolved" && found.value;
        }),
      ),
    );
  };

  const setByRealProject = (): ReadonlySet<string> =>
    new Set(
      FIXTURES.filter(fixtureAvailable).flatMap((candidate) =>
        okAnalysis(candidate)
          .result.entries.filter(
            (entry) => entry.bucket === "used" && entry.id.startsWith(OPTION_PREFIX),
          )
          .map((entry) => entry.id.slice(OPTION_PREFIX.length)),
      ),
    );

  it("should name only options some project configures", () => {
    // The rule is that a listed option has a configured value for the inverse reading to read.
    // A vendored fixture satisfies that as much as a real project does — what it cannot supply
    // is the evidence that the option is worth examining first, which the next test is about.
    const setSomewhere = new Set([
      ...setByRealProject(),
      ...configuredBy(fixtureRoot("overconfigured-app")),
    ]);
    const unset = EXAMINATION_TRANCHES.flat().filter((option) => !setSomewhere.has(option));
    expect(unset).toEqual([]);
  });

  it.skipIf(FIXTURES.filter(fixtureAvailable).length === 0)(
    "should order an option only a fixture configures behind every one a real project sets",
    () => {
      // Configured and worth examining first are separate questions. A fixture was written to
      // make these readable, so its options carry no claim about priority and must not sit in
      // front of an option somebody chose to set in a project of their own.
      const real = setByRealProject();
      const order = EXAMINATION_TRANCHES.flat();
      const positions = (member: (option: string) => boolean): readonly number[] =>
        order.map((option, index) => (member(option) ? index : -1)).filter((index) => index >= 0);
      const fromRealProject = positions((option) => real.has(option));
      const fromFixtureOnly = positions((option) => !real.has(option));
      if (fromRealProject.length === 0 || fromFixtureOnly.length === 0) return;
      expect(Math.max(...fromRealProject)).toBeLessThan(Math.min(...fromFixtureOnly));
    },
  );

  it("should name no option whose page is not a writable configuration key", () => {
    // These pages cannot be reported as used by any project, because the lookup is built from
    // the page name. Listing one would promise an examination that cannot start.
    const undetectable = configuredBy(fixtureRoot("overconfigured-app"));
    const impossible = ["appDir", "incrementalCacheHandlerPath", "staticGeneration"];
    expect(EXAMINATION_TRANCHES.flat().filter((option) => impossible.includes(option))).toEqual([]);
    expect([...undetectable].filter((option) => impossible.includes(option))).toEqual([]);
  });
});

describe.skipIf(!FIXTURES.some(fixtureAvailable))("every referenced configuration resolves", () => {
  /**
   * A change to the config reader can move anything, and the way it fails is silent: a
   * configuration that stops resolving reports no options rather than reporting wrong ones. That
   * shape was measured on a project outside the corpus, which reported every evaluated API as used
   * because none of its configuration was read.
   *
   * Asserted here so the next reader change fails on the projects rather than on somebody noticing
   * a figure that looks plausible.
   */
  eachFixture()("should read the configuration of $fixture.name", ({ fixture }) => {
    const config = readNextConfig(fixture.path);
    expect(config?.object.status).toBe("resolved");
  });

  eachFixture()(
    "should check every documented constraint, or name the value it could not read, on $fixture.name",
    ({ fixture }) => {
      // The count falls when a value a constraint rests on cannot be read, such as a `basePath`
      // computed at load time. Such a constraint is named as unread, so none goes quiet.
      const { result } = okAnalysis(fixture);
      expect(result.constraintsChecked + result.constraintsUnread.length).toBe(13);
    },
  );
});

/**
 * The count of restated entries added to the disclosure. A reader who finds the strict preset
 * noisy is owed a number for how much of it says only *this API exists and you are not using
 * it*, rather than having to read every entry to find out.
 *
 * A property of the catalog rather than of the run, like the reopened count beside it: it says how
 * much of the preset is restatement, which is true whether or not this run asked for the preset.
 */
describe("the restatements the strict preset holds", () => {
  eachFixture()(
    "should count the entries whose page the release documents on $fixture.name",
    ({ fixture }) => {
      // Twelve are written. `use-offline` has no page before 16.3, so a release that documents it
      // counts twelve and one that does not counts eleven — the drift, not a miscount.
      expect([11, 12]).toContain(okAnalysis(fixture, "strict").result.restatedConditions);
    },
  );

  eachFixture()("should say the same under either preset on $fixture.name", ({ fixture }) => {
    expect(okAnalysis(fixture).result.restatedConditions).toBe(
      okAnalysis(fixture, "strict").result.restatedConditions,
    );
  });

  eachFixture()(
    "should hold every one of them behind a reopening on $fixture.name",
    ({ fixture }) => {
      const marked = okAnalysis(fixture, "strict").result.entries.filter(
        (entry) => entry.restatesUsed === true,
      );
      expect(marked.length).toBeGreaterThan(0);
      for (const entry of marked) expect(entry.reopenedFrom, entry.id).toBeDefined();
    },
  );
});
