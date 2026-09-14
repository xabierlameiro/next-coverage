import { describe, expect, inject, it } from "vitest";
import {
  eachFixture,
  FIXTURES,
  type Fixture,
  fixtureAvailable,
  okAnalysis,
  sharedSources,
} from "../test-support/fixtures.js";

describe("the shared analysis", () => {
  it.skipIf(!FIXTURES.some(fixtureAvailable))(
    "should come from the global setup rather than being recomputed per file",
    () => {
      // The helper falls back to analysing here when nothing was provided, which would be correct
      // and slow. This asserts the fast path is the one taken: five files analysing the primary
      // fixture cost 7.7 seconds each before the setup started shipping the result.
      const analyses = inject("fixtureAnalyses");
      const scans = inject("fixtureSources");
      expect(Object.keys(analyses).length).toBeGreaterThan(0);
      for (const fixture of FIXTURES.filter(fixtureAvailable)) {
        expect(analyses).toHaveProperty(`default:${fixture.path}`);
        expect(analyses).toHaveProperty(`strict:${fixture.path}`);
        // The scan is the expensive one: 8.5 seconds on the primary fixture, against 20
        // milliseconds to build a graph from it once it exists.
        expect(scans[fixture.path]?.files.length).toBeGreaterThan(0);
      }
    },
  );
});

describe("every silent entry gives a reason", () => {
  for (const fixture of FIXTURES) {
    describe.skipIf(!fixtureAvailable(fixture))(`${fixture.name} (next ${fixture.next})`, () => {
      it("should account for the whole not-evaluated count", () => {
        const { result } = okAnalysis(fixture);
        const { evaluated, abstained, delegated, unwritten } = result.silence;
        expect(evaluated + abstained + delegated + unwritten).toBe(
          result.notEvaluated - result.skippedForFlag - result.needingBuild,
        );
      });

      it("should leave no silent entry without one", () => {
        const { result } = okAnalysis(fixture);
        const unexplained = result.entries.filter(
          (entry) =>
            entry.bucket === "not-evaluated" &&
            entry.silence === undefined &&
            entry.skippedForFlag === undefined &&
            entry.needsBuild === undefined,
        );
        expect(unexplained.map((entry) => entry.id)).toEqual([]);
      });

      it("should explain every config option the project does not set", () => {
        const { result } = okAnalysis(fixture);
        const silentOptions = result.entries.filter(
          (entry) => entry.bucket === "not-evaluated" && entry.id.startsWith("config/"),
        );
        // Abstained where no condition was written, examined where the option was looked at one
        // at a time and yielded none, evaluated where one was written and did not hold. The
        // options arguing from code the flag leaves inert are the last kind: they ran.
        const explained = silentOptions.filter(
          (entry) =>
            entry.silence?.kind === "abstained" ||
            entry.silence?.kind === "examined" ||
            entry.silence?.kind === "evaluated",
        );
        expect(explained.map((entry) => entry.id)).toEqual(silentOptions.map((entry) => entry.id));
      });
    });
  }
});

describe("dismissals rest on a prerequisite the fixtures disagree about", () => {
  eachFixture()(
    "should cite what it checked on every dismissal on $fixture.name",
    ({ fixture }) => {
      const { result } = okAnalysis(fixture);
      const dismissed = result.entries.filter((entry) => entry.bucket === "not-applicable");
      expect(dismissed.length).toBeGreaterThan(0);
      expect(dismissed.every((entry) => entry.evidence.length > 0)).toBe(true);
      expect(dismissed.every((entry) => entry.note !== undefined)).toBe(true);
    },
  );
});

describe("a failed specifier is sorted by what its failure costs", () => {
  eachFixture()("should account for every module reference on $fixture.name", ({ fixture }) => {
    const sources = sharedSources(fixture);
    const { internal, external, unresolved, assets, missingPackages } = sources.resolution;
    const references = sources.files.reduce(
      (total, file) => total + file.moduleReferences.length,
      0,
    );
    const missing = missingPackages.reduce((total, entry) => total + entry.references, 0);
    expect(internal + external + unresolved + assets + missing).toBe(references);
  });
});

describe("the option cache components removes", () => {
  const ID = "file-conventions/route-segment-config/dynamicParams";

  eachFixture()("should suggest it on no fixture, including $fixture.name", ({ fixture }) => {
    // The condition that looked like a heuristic fired only where the option does not exist. On
    // the one fixture where it does, no route matches — so it was measured and not built.
    expect(okAnalysis(fixture).result.entries.find((e) => e.id === ID)?.bucket).not.toBe(
      "would-apply",
    );
  });
});

describe("the unwritten backlog", () => {
  eachFixture()("should be empty on $fixture.name", ({ fixture }) => {
    const { result } = okAnalysis(fixture);
    const unwritten = result.entries.filter((e) => e.silence?.kind === "unwritten");
    expect(unwritten.map((e) => e.id)).toEqual([]);
    expect(result.silence.unwritten).toBe(0);
  });

  eachFixture()("should account for every silent entry on $fixture.name", ({ fixture }) => {
    const { result } = okAnalysis(fixture);
    const { evaluated, abstained, delegated, unwritten } = result.silence;
    expect(evaluated + abstained + delegated + unwritten).toBe(
      result.notEvaluated - result.skippedForFlag - result.needingBuild,
    );
  });
});

describe("the functions their flag rules out", () => {
  const IDS = ["functions/forbidden", "functions/unauthorized"];

  eachFixture()("should suggest neither on $fixture.name", ({ fixture }) => {
    const { result } = okAnalysis(fixture);
    for (const id of IDS) {
      expect(result.entries.find((e) => e.id === id)?.bucket).not.toBe("would-apply");
    }
  });
});

describe("the build and the derivation agree on every route they share", () => {
  /**
   * A fixture is a real project this repository does not own, so its `.next/` may be absent or
   * older than its source at any moment. A contrast that did not run says why, and a test that
   * asserted through that would be asserting nothing — an empty join would satisfy it.
   */
  const contrastOf = (fixture: Fixture) => {
    const { contrast } = okAnalysis(fixture).result;
    return contrast.reason === undefined ? contrast : undefined;
  };

  eachFixture()("should report no URL disagreement on $fixture.name", ({ fixture }) => {
    // Measured before: 1, 3 and 1, every one an intercepting route whose marker the build keeps
    // in the string and this tool resolves. Notation, not a route the two sides read differently.
    const contrast = contrastOf(fixture);
    if (contrast === undefined) return;
    expect(contrast.join.routes.length).toBeGreaterThan(0);
    expect(contrast.join.disagreements).toEqual([]);
  });

  eachFixture()("should still join the routes it joined before on $fixture.name", ({ fixture }) => {
    // The join itself is untouched: only the comparison of the two URLs changed.
    const contrast = contrastOf(fixture);
    if (contrast === undefined) return;
    const { metadata, framework, unexplained } = contrast.join.unjoined;
    expect(metadata + framework).toBeGreaterThan(0);
    expect(unexplained).toBe(0);
  });
});
