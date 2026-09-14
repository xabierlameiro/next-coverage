import { describe, expect, it } from "vitest";
import {
  FIXTURES,
  type Fixture,
  fixtureAvailable,
  okAnalysis,
} from "../../test-support/fixtures.js";
import type { ConstraintFinding } from "../collect/constraints.js";
import { EMPTY_CONTRAST } from "../collect/contrast.js";
import { EMPTY_WEIGHT_CONTRAST, EMPTY_WEIGHTS } from "../collect/weight.js";
import type { CoverageResult } from "./classify.js";
import { renderReport } from "./render.js";
import type { SerialisedReport } from "./serialise.js";
import { SCHEMA_VERSION, serialiseReport } from "./serialise.js";

const DOCS = {
  path: "04-functions/x.md",
  url: "https://nextjs.org/docs/app/api-reference/functions/x",
};

/**
 * A real fixture, not a vendored one: the contract is over a derived surface, and the surface comes
 * from `node_modules/next/dist/docs/`, which a vendored project does not have.
 */
function contract(fixture: Fixture, preset: "default" | "strict" = "default"): SerialisedReport {
  const analysis = okAnalysis(fixture, preset);
  return serialiseReport(analysis.result, {
    colour: false,
    version: analysis.version,
    projectRoot: analysis.projectRoot,
  });
}

/**
 * A result with nothing in it, for the assertions that are about the contract rather than about
 * any project. Anything resting on which state a fixture's `.next` is in belongs here instead:
 * a build comes and goes, and a contract does not.
 */
const BASE_RESULT: CoverageResult = {
  entries: [],
  used: 0,
  evaluated: 0,
  notApplicable: 0,
  notEvaluated: 0,
  silence: { evaluated: 0, abstained: 0, delegated: 0, unwritten: 0 },
  missingPackages: [],
  unwrittenConditions: 0,
  unexaminedOptions: 0,
  skippedForFlag: 0,
  documentedNotCovered: 0,
  documentedNotAdoptable: 0,
  predicatesWithoutSurface: [],
  partiallyAdopted: 0,
  conditionsNeedingBuild: 0,
  withheldHeuristics: 0,
  reopenedConditions: 0,
  restatedConditions: 0,
  verdictsAgainstThisRelease: 0,
  verdictsAgainstAnOlderRelease: 0,
  verdictsAgainstANewerRelease: 0,
  preset: "default",
  unmatchedDeclarations: 0,
  unresolvedValues: 0,
  boundaryLeaks: 0,
  clientClosure: 0,
  clientReachedWithoutDeclaring: 0,
  placedElsewhere: {},
  unresolvedSpecifiers: 0,
  constraintsChecked: 8,
  constraintsContradicted: 8,
  constraintsWithoutEntry: 0,
  constraintsUnread: [],
  contrast: EMPTY_CONTRAST,
  needingBuild: 0,
  weights: EMPTY_WEIGHTS,
  weightContrast: EMPTY_WEIGHT_CONTRAST,
};

const OPTIONS = { colour: false, version: "16.3.0", projectRoot: "/project" };

describe("the channels that hang off an entry", () => {
  it("should publish an unread option with its reason, not as a count", () => {
    // A consumer comparing `checked` across runs needs the reason to tell a project this tool
    // read less of from a release that checks less, which a number cannot answer.
    const unread = [
      { subject: "redirects", reason: "'redirects' is not written as a function this can read" },
    ];
    const report = serialiseReport({ ...BASE_RESULT, constraintsUnread: unread }, OPTIONS);
    expect(report.constraints.unread).toEqual(unread);
  });
});

describe("what the build recorded", () => {
  /**
   * Synthetic on purpose: asserting this against a real project would make it a claim about
   * whether that project happens to have a `.next` directory, not about the contract itself.
   * Whether a fixture holds a build is not a property of this contract.
   */
  it("should be present and say why when there was no build", () => {
    const result: CoverageResult = { ...BASE_RESULT, contrast: EMPTY_CONTRAST };
    const { build } = serialiseReport(result, OPTIONS);
    expect(build.id).toBeNull();
    expect(build.reason).toBeTypeOf("string");
    expect(build.claimsChecked).toBe(0);
  });
});

describe("the client code each route carries", () => {
  /** Synthetic for the same reason: a fixture's build comes and goes, the contract does not. */
  it("should say why no ordering was contrasted", () => {
    const result: CoverageResult = { ...BASE_RESULT, weightContrast: EMPTY_WEIGHT_CONTRAST };
    const { ordering } = serialiseReport(result, OPTIONS).weights;
    expect(ordering.agreement).toBeNull();
    expect(ordering.reason).toBeTypeOf("string");
  });
});

describe("the contract holds across the corpus", () => {
  for (const fixture of FIXTURES) {
    it.skipIf(!fixtureAvailable(fixture))(
      `should carry all four channels for ${fixture.name}`,
      () => {
        const report = contract(fixture);
        expect(report.totals.evaluated).toBeGreaterThan(0);
        expect(report.constraints.checked).toBeGreaterThan(0);
        expect(report.build).toBeDefined();
        expect(report.weights.routes.length).toBeGreaterThan(0);
        expect(JSON.parse(JSON.stringify(report))).toEqual(report);
      },
    );
  }
});

/**
 * A path that only means something on the machine that produced the file defeats the point of a
 * contract. Three entries used to cite their documentation as an absolute path into
 * `node_modules/next/dist/docs/`, carrying the temp directory and the install layout of the run.
 */
describe("the contract carries no path of the producing machine", () => {
  for (const fixture of FIXTURES) {
    it.skipIf(!fixtureAvailable(fixture))(
      `should keep every path relative for ${fixture.name}`,
      () => {
        const report = contract(fixture);
        const absolute: string[] = [];
        for (const entry of report.entries) {
          for (const path of entry.evidence ?? []) {
            if (path.startsWith("/")) absolute.push(`${entry.id} -> ${path}`);
          }
          for (const path of entry.alsoWouldApply?.evidence ?? []) {
            if (path.startsWith("/")) absolute.push(`${entry.id} -> ${path}`);
          }
        }
        expect(absolute).toEqual([]);
      },
    );
  }
});

/**
 * Only three of the eight constraint kinds are contradicted by any project measured so far —
 * `restates-default`, `intercepted-route` and `slot-mode` — so the other five would go through the
 * serialiser untested against real data. These are synthetic on purpose, and each asserts every
 * field the kind declares: the `switch` is what makes a ninth kind a compile error, and this is
 * what makes a dropped field on one of the eight a failing test.
 */
describe("every constraint kind survives the contract", () => {
  const FINDINGS: readonly ConstraintFinding[] = [
    {
      kind: "slot-mode",
      entry: "file-conventions/parallel-routes",
      segment: "app/[lang]",
      staticSlots: [{ slot: "@footer", directory: "app/[lang]/@footer" }],
      cause: "app/[lang]/@feed/page.tsx",
      causeChain: ["app/[lang]/@feed/page.tsx", "app/lib/live.ts"],
      otherDynamic: 2,
    },
    {
      kind: "restates-default",
      entry: "config/next-config-js/optimizePackageImports",
      option: "experimental.optimizePackageImports",
      packages: ["lucide-react"],
      whatNextDoes: "already optimizes imports for it by default",
      source: "next.config.ts",
    },
    {
      kind: "intercepted-route",
      entry: "config/next-config-js/redirects",
      option: "redirects",
      routes: [{ pattern: "/favicon.png", serves: "app/favicon.png/route.ts" }],
      source: "next.config.ts",
      unread: 1,
    },
    {
      kind: "unprefixed-asset",
      entry: "config/next-config-js/basePath",
      option: "basePath",
      prefix: "/docs",
      assets: [{ file: "app/page.tsx", value: "/logo.png" }],
      source: "next.config.ts",
    },
    {
      kind: "missing-module",
      entry: "config/next-config-js/cacheHandler",
      option: "cacheHandler",
      modules: [{ value: "./cache-handler.mjs", as: "path" }],
      source: "next.config.ts",
      unread: 2,
    },
    {
      kind: "bundler-scope",
      entry: "config/next-config-js/turbopack",
      settings: [{ option: "turbopack.rules", value: "*.svg", scope: "turbopack" }],
      running: ["webpack"],
      source: "next.config.ts",
    },
    {
      kind: "failing-combination",
      entry: "config/next-config-js/reactCompiler",
      option: "reactCompiler",
      withPackage: "babel-plugin-react-compiler",
      majorInstalled: 18,
      consequence: "the compiler is skipped",
      source: "next.config.ts",
    },
    {
      kind: "segment-config-removed",
      entry: "config/next-config-js/cacheComponents",
      option: "cacheComponents",
      segments: [{ file: "app/page.tsx", exported: "dynamic" }],
      consequence: "next build stops on each of them",
      source: "next.config.ts",
    },
    {
      kind: "absent-prerequisite",
      entry: "config/next-config-js/mdxRs",
      option: "mdxRs",
      needs: "the MDX integration",
      source: "next.config.ts",
    },
  ];

  function serialisedFindings() {
    const result: CoverageResult = {
      ...BASE_RESULT,
      entries: [
        {
          id: "synthetic",
          domain: "config",
          title: "synthetic",
          docs: DOCS,
          bucket: "used",
          evidence: ["next.config.ts"],
          constraints: { note: "documented rules this project contradicts", items: FINDINGS },
        },
      ],
    };
    const report = serialiseReport(result, {
      colour: false,
      version: "16.3.0",
      projectRoot: "/project",
    });
    return report.entries[0]?.constraints?.items ?? [];
  }

  it("should publish all eight kinds", () => {
    expect(serialisedFindings().map((finding) => finding.kind)).toEqual(
      FINDINGS.map((finding) => finding.kind),
    );
  });

  it("should drop no field of any kind", () => {
    const published = serialisedFindings();
    for (const [index, source] of FINDINGS.entries()) {
      // Field for field against the internal finding: a key the switch forgot fails here.
      expect(published[index]).toEqual(source);
    }
  });

  it("should survive JSON encoding for every kind", () => {
    const published = serialisedFindings();
    expect(JSON.parse(JSON.stringify(published))).toEqual(published);
  });
});

describe("the workspace packages a project links to", () => {
  it("should be absent for a project outside any workspace", () => {
    expect(serialiseReport(BASE_RESULT, OPTIONS).totals.linkedPackages).toBeUndefined();
  });

  /**
   * Absent rather than zero, because a consumer reading zero would take it for a monorepo linking
   * nothing — a different fact from a project where the question does not arise.
   */
  it("should carry both counts where the project links to something", () => {
    const linked = { ...BASE_RESULT, linkedPackages: { scanned: 2, unmatched: 1 } };
    expect(serialiseReport(linked, OPTIONS).totals.linkedPackages).toEqual({
      scanned: 2,
      unmatched: 1,
    });
  });

  it("should not change the schema version, because only a field was added", () => {
    const linked = { ...BASE_RESULT, linkedPackages: { scanned: 1, unmatched: 0 } };
    expect(serialiseReport(linked, OPTIONS).schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("the release each verdict was measured against", () => {
  /**
   * Two figures rather than one with a sign: they are different facts. One says a page here has
   * not been re-read, the other says the project is behind the pages it was read against, and a
   * consumer acting on either needs to know which arrived.
   */
  it("should publish both directions as counts of their own", () => {
    const totals = serialiseReport(
      { ...BASE_RESULT, verdictsAgainstAnOlderRelease: 3, verdictsAgainstANewerRelease: 2 },
      OPTIONS,
    ).totals;
    expect(totals.verdictsAgainstAnOlderRelease).toBe(3);
    expect(totals.verdictsAgainstANewerRelease).toBe(2);
  });

  it("should publish zero rather than omitting the count", () => {
    expect(serialiseReport(BASE_RESULT, OPTIONS).totals.verdictsAgainstANewerRelease).toBe(0);
  });
});

describe("a surface that could not be derived", () => {
  const REASON = "no installed next package was found";

  it("should carry null where a surface was derived", () => {
    expect(serialiseReport(BASE_RESULT, OPTIONS).surfaceUnavailable).toBeNull();
  });

  it("should carry the reason where none was", () => {
    const report = serialiseReport(BASE_RESULT, { ...OPTIONS, surfaceUnavailable: REASON });
    expect(report.surfaceUnavailable).toBe(REASON);
  });

  /**
   * The defect the field exists for: a run that derived nothing publishes an empty `entries` and
   * every total at zero, which is what a project the analysis found nothing to suggest for also
   * publishes. Only this field separates them.
   */
  it("should be the one field separating it from a project with nothing to suggest", () => {
    const derived = serialiseReport(BASE_RESULT, OPTIONS);
    const underivable = serialiseReport(BASE_RESULT, { ...OPTIONS, surfaceUnavailable: REASON });
    expect(underivable.entries).toEqual(derived.entries);
    expect(underivable.totals).toEqual(derived.totals);
    const differing = Object.keys(underivable).filter(
      (key) =>
        JSON.stringify(underivable[key as keyof SerialisedReport]) !==
        JSON.stringify(derived[key as keyof SerialisedReport]),
    );
    expect(differing).toEqual(["surfaceUnavailable"]);
  });

  it("should not change the schema version, because only a field was added", () => {
    expect(
      serialiseReport(BASE_RESULT, { ...OPTIONS, surfaceUnavailable: REASON }).schemaVersion,
    ).toBe(SCHEMA_VERSION);
  });

  it("should state the same reason the rendered report prints", () => {
    const options = { ...OPTIONS, surfaceUnavailable: REASON };
    expect(serialiseReport(BASE_RESULT, options).surfaceUnavailable).toBe(REASON);
    expect(renderReport(BASE_RESULT, options)).toContain(REASON);
  });
});

describe("the examination that ran and found nothing", () => {
  it("should serialise as present and empty, apart from a withheld channel", () => {
    const ran = serialiseReport(
      {
        ...BASE_RESULT,
        preset: "strict",
        clientDirectivesWithoutReason: 0,
        entries: [
          {
            id: "directives/use-client",
            domain: "directives",
            title: "use client",
            docs: DOCS,
            bucket: "used",
            evidence: ["app/panel/Filtros.tsx"],
            directivesWithoutReason: { note: "note", items: [] },
          },
        ],
      },
      OPTIONS,
    );
    const entry = ran.entries.find((one) => one.id === "directives/use-client");
    expect(entry?.directivesWithoutReason).toEqual([]);
    expect(ran.totals.clientDirectivesWithoutReason).toBe(0);
  });
});

/**
 * The reopening is the one thing on a suggestion that says how much weight it carries, so a script
 * reading the contract has to be able to see it. The count is derivable from the entries, which is
 * what makes it checkable against them rather than merely present.
 */
describe("a reopened condition in the contract", () => {
  const REOPENED = {
    condition: "an option set to the value the framework already applies",
    outcome: "the configuration restating a default is not an adoption gap",
  } as const;

  const withReopened = (count: number): SerialisedReport =>
    serialiseReport(
      {
        ...BASE_RESULT,
        reopenedConditions: count,
        entries: Array.from({ length: count }, (_, index) => ({
          id: `config/next-config-js/option-${index}`,
          domain: "config",
          title: `option-${index}`,
          docs: DOCS,
          bucket: "would-apply" as const,
          evidence: ["next.config.ts"],
          note: "a shape it argues from",
          gain: "what adopting it buys",
          reopenedFrom: REOPENED,
        })),
      },
      OPTIONS,
    );

  it("should carry the refusal on the entry it belongs to", () => {
    const [entry] = withReopened(1).entries;
    expect(entry?.reopenedFrom).toEqual(REOPENED);
  });

  it("should omit the field entirely where the condition reopened nothing", () => {
    const plain = serialiseReport(
      {
        ...BASE_RESULT,
        entries: [
          {
            id: "file-conventions/page",
            domain: "file-conventions",
            title: "page.js",
            docs: DOCS,
            bucket: "would-apply",
            evidence: ["app/page.tsx"],
            note: "a shape it argues from",
            gain: "what adopting it buys",
          },
        ],
      },
      OPTIONS,
    );
    const [entry] = plain.entries;
    expect(entry).toBeDefined();
    expect(entry !== undefined && "reopenedFrom" in entry).toBe(false);
  });

  it("should agree with the entries it is counting", () => {
    const report = withReopened(3);
    const carrying = report.entries.filter((entry) => entry.reopenedFrom !== undefined);
    expect(report.totals.reopenedConditions).toBe(carrying.length);
  });
});
