import { describe, expect, inject, it } from "vitest";
import { realCodeAvailable } from "../../test-support/fixtures.js";
import { EMPTY_CONTRAST } from "../collect/contrast.js";
import { EMPTY_WEIGHT_CONTRAST, EMPTY_WEIGHTS } from "../collect/weight.js";
import type { CoverageResult } from "./classify.js";
import {
  FINDING_CHANNELS,
  hasFinding,
  renderFindings,
  renderReport,
  renderStop,
} from "./render.js";

const DOCS = {
  path: "04-functions/x.md",
  url: "https://nextjs.org/docs/app/api-reference/functions/x",
};

const RESULT: CoverageResult = {
  entries: [
    {
      id: "file-conventions/page",
      domain: "file-conventions",
      title: "page.js",
      docs: DOCS,
      bucket: "used",
      evidence: ["app/page.tsx"],
    },
    {
      id: "file-conventions/default",
      domain: "file-conventions",
      title: "default.js",
      docs: DOCS,
      bucket: "would-apply",
      evidence: ["app/@modal"],
      note: "these parallel slots 404 on a hard navigation without a default",
      gain: "a default file gives the slot something to render on a hard navigation instead of a 404",
    },
  ],
  used: 1,
  evaluated: 2,
  notApplicable: 0,
  notEvaluated: 0,
  silence: { evaluated: 0, abstained: 0, delegated: 0, unwritten: 0 },
  missingPackages: [],
  unwrittenConditions: 0,
  unexaminedOptions: 0,
  skippedForFlag: 0,
  documentedNotCovered: 5,
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
  constraintsChecked: 1,
  constraintsContradicted: 0,
  constraintsWithoutEntry: 0,
  constraintsUnread: [],
  contrast: EMPTY_CONTRAST,
  needingBuild: 0,
  weights: EMPTY_WEIGHTS,
  weightContrast: EMPTY_WEIGHT_CONTRAST,
};

const OPTIONS = { colour: false, version: "16.3.0", projectRoot: "/project" };

const WITH_UNMATCHED: CoverageResult = {
  ...RESULT,
  entries: [
    {
      id: "functions/cacheTag",
      domain: "functions",
      title: "cacheTag",
      docs: DOCS,
      bucket: "used",
      evidence: ["app/a.ts"],
      unmatched: {
        note: "declared here, and no invalidation names them anywhere in the project",
        declarations: [{ value: "public-news", files: ["app/news/page.tsx"] }],
      },
    },
  ],
  unmatchedDeclarations: 1,
  unresolvedValues: 3,
};

describe("unmatched declarations", () => {
  it("should list them under the entry without changing its bucket", () => {
    const output = renderReport(WITH_UNMATCHED, OPTIONS);
    expect(output).toContain("Used");
    expect(output).toContain("public-news");
    expect(output).toContain("app/news/page.tsx");
  });

  it("should name what was searched for and not found", () => {
    expect(renderReport(WITH_UNMATCHED, OPTIONS)).toContain(
      "no invalidation names them anywhere in the project",
    );
  });

  it("should not blame either side", () => {
    // Whole phrases, not substrings: "invalidation" is the domain term here, and banning
    // "invalid" would fail on the correct wording. The same trap as "error" and "score".
    const output = renderReport(WITH_UNMATCHED, OPTIONS).toLowerCase();
    for (const banned of ["is wrong", "you should", "must fix", "should be removed", "is a bug"]) {
      expect(output).not.toContain(banned);
    }
  });

  it("should disclose the counts of unmatched and unreadable values", () => {
    const output = renderReport(WITH_UNMATCHED, OPTIONS);
    expect(output).toContain("1 declaration with no counterpart elsewhere");
    expect(output).toContain("3 values could not be read");
  });

  it("should say nothing when everything matched", () => {
    const output = renderReport(RESULT, OPTIONS);
    expect(output).not.toContain("no counterpart");
    expect(output).not.toContain("could not be read");
  });
});

const WITH_LEAKS: CoverageResult = {
  ...RESULT,
  entries: [
    {
      id: "directives/use-client",
      domain: "directives",
      title: "'use client'",
      docs: DOCS,
      bucket: "used",
      evidence: ["app/panel.tsx"],
      leaks: {
        note: "these modules are on the client side of the boundary and import server-only code",
        items: [
          {
            module: "app/utils/bedrock/index.ts",
            specifier: "server-only",
            chain: ["app/panel.tsx", "app/lib/proposal.ts", "app/utils/bedrock/index.ts"],
          },
        ],
      },
    },
  ],
  boundaryLeaks: 1,
  clientClosure: 619,
  clientReachedWithoutDeclaring: 301,
  unresolvedSpecifiers: 755,
};

describe("boundary leaks", () => {
  it("should name the module and what it imports", () => {
    const output = renderReport(WITH_LEAKS, OPTIONS);
    expect(output).toContain("app/utils/bedrock/index.ts");
    expect(output).toContain("imports server-only");
  });

  it("should print the chain that puts the module on the client side", () => {
    expect(renderReport(WITH_LEAKS, OPTIONS)).toContain(
      "app/panel.tsx → app/lib/proposal.ts → app/utils/bedrock/index.ts",
    );
  });

  it("should not claim anything about the build, which may shake the edge out", () => {
    // Whole phrases again: "build" alone would be a fair word elsewhere in a report about a
    // bundler, and banning it would ban the correct wording along with the wrong one.
    const output = renderReport(WITH_LEAKS, OPTIONS).toLowerCase();
    for (const banned of [
      "the build fails",
      "will fail",
      "breaks the build",
      "is broken",
      "you should",
      "must fix",
    ]) {
      expect(output).not.toContain(banned);
    }
  });

  it("should keep the entry in its bucket", () => {
    const output = renderReport(WITH_LEAKS, OPTIONS);
    expect(output).toContain("Used");
    expect(output).not.toContain("Would apply");
  });

  it("should disclose the size of the boundary and what could not be resolved", () => {
    const output = renderReport(WITH_LEAKS, OPTIONS);
    expect(output).toContain("619 files are on the client side of the boundary");
    expect(output).toContain("301 of them without declaring it");
    expect(output).toContain("755 imports could not be resolved");
  });

  it("should say nothing about a boundary it never derived", () => {
    const output = renderReport(RESULT, OPTIONS);
    expect(output).not.toContain("client side of the boundary");
    expect(output).not.toContain("imports could not be resolved");
  });
});

describe("report rendering", () => {
  it("should never emit a severity, a score or a grade", () => {
    // `error` is deliberately absent from this list: Next.js has a convention named
    // error.js, so banning the word would fail on any project that uses it.
    const output = renderReport(RESULT, OPTIONS).toLowerCase();
    for (const banned of ["severity", "score", "critical", "warning:", "failed", "/10", "/100"]) {
      expect(output).not.toContain(banned);
    }
  });

  it("should present a would-apply entry with its condition, not as a problem", () => {
    const output = renderReport(RESULT, OPTIONS);
    expect(output).toContain("Would apply");
    expect(output).toContain("404 on a hard navigation");
  });

  // The gain completes the note's sentence, the page is where to go next, and the evidence is
  // what to look at. The order is the order a reader needs them in.
  it("should print the gain, then the page, then the evidence beneath a would-apply entry", () => {
    const lines = renderReport(RESULT, OPTIONS).split("\n");
    const title = lines.findIndex((line) => line.includes("default.js —"));
    expect(title).toBeGreaterThan(-1);
    expect(lines[title + 1]).toBe(
      "      a default file gives the slot something to render on a hard navigation instead of a 404",
    );
    expect(lines[title + 2]).toBe(`      ${DOCS.url}`);
    expect(lines[title + 3]).toBe("      app/@modal");
  });

  it("should print neither line beneath a used entry with nothing to suggest", () => {
    const lines = renderReport(RESULT, OPTIONS).split("\n");
    const title = lines.findIndex((line) => line.trim() === "page.js");
    expect(title).toBeGreaterThan(-1);
    expect(lines[title + 1]).toBe("      app/page.tsx");
  });

  it("should print the gain and the page beneath a partial adoption", () => {
    const partial: CoverageResult = {
      ...RESULT,
      entries: [
        {
          id: "components/image",
          domain: "components",
          title: "Image",
          docs: DOCS,
          bucket: "used",
          evidence: ["app/page.tsx"],
          alsoWouldApply: {
            note: "these render a raw img element",
            gain: "Image serves each one resized to the viewport",
            evidence: ["app/galeria/page.tsx"],
          },
        },
      ],
    };
    const lines = renderReport(partial, OPTIONS).split("\n");
    const also = lines.findIndex((line) => line.includes("also applies in 1 more"));
    expect(also).toBeGreaterThan(-1);
    expect(lines[also + 1]).toBe("        Image serves each one resized to the viewport");
    expect(lines[also + 2]).toBe(`        ${DOCS.url}`);
    expect(lines[also + 3]).toBe("        app/galeria/page.tsx");
  });

  it("should print each reason's files under its own sentence", () => {
    const composed: CoverageResult = {
      ...RESULT,
      entries: [
        {
          id: "directives/use-cache",
          domain: "directives",
          title: "use cache",
          docs: DOCS,
          bucket: "used",
          evidence: ["app/page.tsx"],
          alsoWouldApply: {
            note: "the deprecated import; the unstated fetch",
            gain: "what adopting it buys",
            evidence: ["app/fetch.ts", "app/legacy.ts"],
            reasons: [
              { note: "the deprecated import", gain: "one", evidence: ["app/legacy.ts"] },
              { note: "the unstated fetch", gain: "two", evidence: ["app/fetch.ts"] },
            ],
          },
        },
      ],
    };
    const lines = renderReport(composed, OPTIONS).split("\n");
    const also = lines.findIndex((line) => line.includes("also applies in 2 more"));
    expect(lines.slice(also + 3, also + 7)).toEqual([
      "        the deprecated import",
      "          app/legacy.ts",
      "        the unstated fetch",
      "          app/fetch.ts",
    ]);
  });

  it("should print both lines as plain text when output is piped", () => {
    const output = renderReport(RESULT, { ...OPTIONS, colour: false });
    expect(output).toContain(`      ${DOCS.url}`);
    expect(output).not.toContain("\u001b[");
  });

  // A chain is evidence for one finding, so it has to stay on one line: split across three it
  // would read as three separate places rather than one path through the project.
  it("should keep an import chain on a single line", () => {
    const chain = "app/admin/page.tsx → app/lib/index.ts → app/lib/read.ts";

    const withChain = {
      ...RESULT,
      entries: [
        {
          id: "file-conventions/not-found",
          domain: "file-conventions",
          title: "not-found.js",
          docs: DOCS,
          bucket: "would-apply" as const,
          evidence: [chain],
          note: "these routes reach a module calling notFound()",
        },
      ],
    };
    const lines = renderReport(withChain, OPTIONS).split("\n");
    expect(lines.filter((line) => line.includes("→"))).toHaveLength(1);
    expect(lines.find((line) => line.includes("→"))?.trim()).toBe(chain);
  });

  it("should show a contradicted constraint under its entry, with the chain on one line", () => {
    const chain = "app/@loud/default.tsx → lib/session.ts";
    const withConstraint = {
      ...RESULT,
      constraintsContradicted: 1,
      entries: [
        {
          id: "file-conventions/parallel-routes",
          domain: "file-conventions",
          title: "parallel routes",
          docs: DOCS,
          bucket: "used" as const,
          evidence: ["app/@loud"],
          constraints: {
            note: "these slots render dynamically because a sibling at the same level does",
            items: [
              {
                kind: "slot-mode" as const,
                entry: "file-conventions/parallel-routes",
                segment: "app",
                staticSlots: [{ slot: "quiet", directory: "app/@quiet" }],
                cause: "loud",
                causeChain: ["app/@loud/default.tsx", "lib/session.ts"],
                otherDynamic: 1,
              },
            ],
          },
        },
      ],
    };
    const output = renderReport(withConstraint, OPTIONS);
    expect(output).toContain("@quiet beside @loud and 1 more");
    const lines = output.split("\n").filter((line) => line.includes("→"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.trim()).toBe(chain);
    // The entry keeps the bucket it earned; the finding does not move it.
    expect(output).toContain("Used");
  });

  // A silent section reads as nothing checked. The count is what makes it read as nothing found.
  it("should state the constraints it checked when none is contradicted", () => {
    expect(renderReport(RESULT, OPTIONS)).toContain(
      "1 documented constraint checked, none contradicted",
    );
  });

  it("should state the ratio as used over evaluated", () => {
    expect(renderReport(RESULT, OPTIONS)).toContain("1 of 2 evaluated APIs are in use");
  });

  it("should disclose the surface it cannot detect", () => {
    expect(renderReport(RESULT, OPTIONS)).toContain("5 documented APIs this tool cannot detect");
  });

  it("should disclose the pages it excluded from that figure", () => {
    const excluded = { ...RESULT, documentedNotAdoptable: 16 };
    const output = renderReport(excluded, OPTIONS);
    expect(output).toContain("5 documented APIs this tool cannot detect");
    expect(output).toContain("16 documented pages excluded");
  });

  it("should say nothing about exclusions when there were none", () => {
    expect(renderReport(RESULT, OPTIONS)).not.toContain("excluded");
  });

  // Every note in this block is a count, and a count of one is the value each of them reaches
  // first on a small project. Asserted together because they share the failure: a figure printed
  // beside the wrong noun reads as a bug in the tool, which is the doubt a report cannot afford.
  it("should agree with its own counts when each of them is one", () => {
    const singular: CoverageResult = {
      ...RESULT,
      unmatchedDeclarations: 1,
      unresolvedValues: 1,
      clientClosure: 1,
      clientReachedWithoutDeclaring: 1,
      unresolvedSpecifiers: 1,
      constraintsWithoutEntry: 1,
      withheldHeuristics: 1,
      documentedNotCovered: 1,
      unwrittenConditions: 1,
      unexaminedOptions: 1,
      predicatesWithoutSurface: ["config/next-config-js/somethingNextRemoved"],
      documentedNotAdoptable: 1,
    };
    const output = renderReport(singular, OPTIONS);
    expect(output).toContain("1 declaration with no counterpart elsewhere");
    expect(output).toContain("1 value could not be read");
    expect(output).toContain("1 file is on the client side of the boundary");
    expect(output).toContain("1 import could not be resolved");
    expect(output).toContain("1 framework default has no option page to report against");
    expect(output).toContain("1 opt-in suggestion withheld");
    expect(output).toContain("1 documented API this tool cannot detect yet");
    expect(output).toContain("1 API carries a condition believed to exist");
    expect(output).toContain("1 config option has not been examined one at a time");
    expect(output).toContain("1 API this tool detects is not documented by this version");
    expect(output).toContain("1 documented page excluded: it covers");
  });

  it("should name the key when a restated default sits inside an option", () => {
    const withNested: CoverageResult = {
      ...RESULT,
      entries: [
        {
          id: "config/next-config-js/typescript",
          domain: "config",
          title: "typescript",
          docs: DOCS,
          bucket: "used" as const,
          evidence: ["next.config.ts"],
          constraints: {
            note: "the framework applies these to every project, so the configuration states what it already does",
            items: [
              {
                kind: "restates-default" as const,
                entry: "config/next-config-js/typescript",
                option: "typescript.ignoreBuildErrors",
                packages: ["false"],
                whatNextDoes: "Next.js already applies",
                source: "next.config.ts",
              },
            ],
          },
        },
      ],
    };
    const output = renderReport(withNested, OPTIONS);
    expect(output).toContain("typescript.ignoreBuildErrors");
    expect(output).toContain("false");
    // The finding names what the framework does and stops there. A project may write the line to
    // say it does not want the behaviour, and which case this is cannot be read from the source.
    const lowered = output.toLowerCase();
    for (const banned of ["remove", "redundant", "unnecessary", "you should", "delete"]) {
      expect(lowered).not.toContain(banned);
    }
    expect(output).toContain("Used");
  });

  it("should state how many config options nobody has examined one at a time", () => {
    const remaining = { ...RESULT, unexaminedOptions: 49 };
    expect(renderReport(remaining, OPTIONS)).toContain(
      "49 config options have not been examined one at a time",
    );
  });

  it("should state the remainder even when it reaches zero", () => {
    // The same rule the backlog follows: a remainder asserted as zero is a claim that can fail,
    // and one left unsaid cannot.
    expect(renderReport(RESULT, OPTIONS)).toContain(
      "every documented config option has been examined one at a time",
    );
  });

  it("should state the remainder as a count of pages, never as a share of anything", () => {
    const output = renderReport({ ...RESULT, unexaminedOptions: 49 }, OPTIONS);
    const line = output.split("\n").find((text) => text.includes("examined one at a time")) ?? "";
    expect(line).not.toMatch(/%|\bof\b|score|severity|coverage/i);
  });

  it("should never withhold suggestions silently", () => {
    const withheld = { ...RESULT, withheldHeuristics: 4 };
    const output = renderReport(withheld, OPTIONS);
    expect(output).toContain("4 opt-in suggestions withheld");
    expect(output).toContain("--strict");
  });

  it("should say nothing about opt-in heuristics when none were withheld", () => {
    expect(renderReport(RESULT, OPTIONS)).not.toContain("withheld");
  });

  it("should omit the ratio when nothing could be evaluated", () => {
    const empty: CoverageResult = { ...RESULT, entries: [], used: 0, evaluated: 0 };
    const output = renderReport(empty, OPTIONS);
    expect(output).toContain("Nothing could be evaluated");
    expect(output).not.toContain("evaluated APIs are in use");
  });

  it("should emit no colour codes when colour is off", () => {
    expect(renderReport(RESULT, OPTIONS)).not.toContain("[");
  });

  it("should emit colour codes when colour is on", () => {
    expect(renderReport(RESULT, { ...OPTIONS, colour: true })).toContain("[");
  });

  it("should explain an unavailable surface instead of showing empty buckets", () => {
    const output = renderReport(RESULT, { ...OPTIONS, surfaceUnavailable: "no bundled docs" });
    expect(output).toContain("Surface could not be derived: no bundled docs");
    expect(output).not.toContain("Would apply");
  });

  it("should explain why analysis stopped", () => {
    expect(renderStop({ kind: "no-project", from: "/tmp/x" }, false)).toContain(
      "No Next.js project found",
    );
    expect(
      renderStop({ kind: "no-app-router", root: "/p", hasPagesRouter: true }, false),
    ).toContain("Pages Router");
  });
});

describe.skipIf(!realCodeAvailable())("the built cli", () => {
  // Built and run once in global setup, so these assert on a binary that matches the source
  // without any worker spawning a process. See test-support/build-cli.ts.

  it("should print a report for a real project", () => {
    const run = inject("cliOnProject");
    expect(run?.status).toBe(0);
    expect(run?.output).toContain("next-coverage");
  });

  /**
   * It used to exit zero here, and that was specified. It no longer does: zero says the project
   * was analysed, and nothing was. The reason moves to stderr with it, so a caller capturing
   * stdout gets the report or nothing.
   */
  it("should exit non-zero when there is no project to analyse", () => {
    const run = inject("cliWithoutProject");
    expect(run.status).toBe(2);
    expect(run.output).toBe("");
    expect(run.stderr).toContain("No Next.js project found");
  });
});

describe("predicate drift", () => {
  it("should say how many of its predicates this version does not document", () => {
    const drifted = { ...RESULT, predicatesWithoutSurface: ["a/b", "c/d", "e/f", "g/h"] };
    const output = renderReport(drifted, OPTIONS);
    expect(output).toContain("4 APIs this tool detects are not documented by this version");
    // Both directions of the drift, side by side.
    expect(output).toContain("5 documented APIs this tool cannot detect");
  });

  it("should name them, because a count is the one thing nobody can act on", () => {
    // A project holding `app/global-not-found.tsx` reads its whole report without seeing the
    // file once: with no documented page there is no entry, and with no entry there is no
    // bucket. The disclosure is the only place it can be told, so it says which.
    const drifted = { ...RESULT, predicatesWithoutSurface: ["file-conventions/global-not-found"] };
    const output = renderReport(drifted, OPTIONS);
    expect(output).toContain("1 API this tool detects is not documented by this version:");
    // On its own line: sixteen of these on a pre-16.3 project wrap into a paragraph otherwise.
    expect(output).toContain("\n    file-conventions/global-not-found\n");
  });

  it("should say nothing when every predicate has a surface", () => {
    expect(renderReport(RESULT, OPTIONS)).not.toContain("not documented by this version");
  });
});

describe("the build contrast section", () => {
  it("appears with its reason when no build was read", () => {
    const report = renderReport(RESULT, {
      colour: false,
      version: "16.3.0",
      projectRoot: "/project",
    });
    expect(report).toContain("Build contrast");
    expect(report).toContain("nothing contrasted: no build was read");
  });

  it("names the build and how many claims agreed", () => {
    const report = renderReport(
      {
        ...RESULT,
        contrast: {
          findings: [],
          checked: 3,
          unanswered: { absentRoute: 1, undecidedMode: 0 },
          withdrawn: 0,
          unreadableEntries: 0,
          buildId: "abc123",
          join: {
            routes: [],
            unjoinedRoutes: 0,
            unjoined: { metadata: 0, framework: 0, unexplained: 0 },
            disagreements: [],
          },
        },
      },
      { colour: false, version: "16.3.0", projectRoot: "/project" },
    );
    expect(report).toContain(
      "build abc123: 3 rendering-mode claims checked, and the build agreed with all of them",
    );
    expect(report).toContain("1 claim about a route the build's own mapping does not list");
  });

  // The count a real project reaches: one route declaring a mode is enough to contrast, and the
  // first version of this line said `1 rendering-mode claims checked`.
  it("names a single claim in the singular", () => {
    const report = renderReport(
      {
        ...RESULT,
        contrast: {
          findings: [],
          checked: 1,
          unanswered: { absentRoute: 0, undecidedMode: 0 },
          withdrawn: 0,
          unreadableEntries: 0,
          buildId: "abc123",
          join: {
            routes: [],
            unjoinedRoutes: 0,
            unjoined: { metadata: 0, framework: 0, unexplained: 0 },
            disagreements: [],
          },
        },
      },
      { colour: false, version: "16.3.0", projectRoot: "/project" },
    );
    expect(report).toContain(
      "build abc123: 1 rendering-mode claim checked, and the build agreed with it",
    );
  });

  it("states what the build produced without calling the code wrong", () => {
    const report = renderReport(
      {
        ...RESULT,
        contrast: {
          findings: [
            {
              claim: "slot-prerendering",
              route: "/dash",
              source: "app/dash/@aside",
              expected: "not prerendered, because @main at the same level is dynamic",
              recorded: "prerendered in full",
            },
          ],
          checked: 1,
          unanswered: { absentRoute: 0, undecidedMode: 0 },
          withdrawn: 0,
          unreadableEntries: 0,
          buildId: "abc123",
          join: {
            routes: [],
            unjoinedRoutes: 0,
            unjoined: { metadata: 0, framework: 0, unexplained: 0 },
            disagreements: [],
          },
        },
      },
      { colour: false, version: "16.3.0", projectRoot: "/project" },
    );
    expect(report).toContain("1 disagreed");
    expect(report).toContain("/dash app/dash/@aside");
    expect(report).toContain("the build recorded it prerendered in full");
  });

  it("counts entries needing a build apart from those skipped for a flag", () => {
    const report = renderReport(
      { ...RESULT, notEvaluated: 3, skippedForFlag: 1, needingBuild: 2 },
      { colour: false, version: "16.3.0", projectRoot: "/project" },
    );
    expect(report).toContain("1 skipped because a config flag is off or unresolved");
    expect(report).toContain("2 skipped because there is no build to read them against");
    expect(report).not.toContain("had no verdict");
  });
});

const WEIGHTED = {
  ...RESULT,
  weights: {
    urlSource: "build" as const,
    routes: [
      { url: "/dash", modules: new Set(["a", "b", "c"]), filePathRoutes: [], entries: [] },
      { url: "/blog", modules: new Set(["a"]), filePathRoutes: [], entries: [] },
    ],
  },
};

describe("the client weight section", () => {
  it("names the routes carrying the most client code, with no verdict", () => {
    const report = renderReport(WEIGHTED, {
      colour: false,
      version: "16.3.0",
      projectRoot: "/project",
    });
    expect(report).toContain("Client weight");
    expect(report).toContain("/dash 3 client modules");
    expect(report).not.toMatch(/heavy|too much|should|reduce/i);
  });

  it("appears with the counts when no build was read", () => {
    const report = renderReport(WEIGHTED, {
      colour: false,
      version: "16.3.0",
      projectRoot: "/project",
    });
    expect(report).toContain("/blog 1 client module");
    expect(report).toContain("no ordering contrasted: no build was read");
  });

  it("states the agreement as a fact about this tool's derivation", () => {
    const report = renderReport(
      {
        ...WEIGHTED,
        weightContrast: {
          orderedPairs: 4371,
          agreement: 0.84,
          separation: { whenDiffering: 15 * 1024, whenAgreeing: 41 * 1024 },
          compared: 94,
          withoutFigure: 26,
          ranked: [
            { url: "/dash", modules: 3, bytes: 204800, byModules: 1, byBytes: 1, gap: 0 },
            { url: "/blog", modules: 1, bytes: 102400, byModules: 2, byBytes: 2, gap: 0 },
          ],
          furthest: [
            { url: "/odd", modules: 9, bytes: 102400, byModules: 2, byBytes: 40, gap: 38 },
          ],
        },
      },
      { colour: false, version: "16.3.0", projectRoot: "/project" },
    );
    // Named as a proportion of pairs, with the routes they came from beside it: 84% is not a
    // figure over 94 routes, and the earlier wording read as though it were.
    expect(report).toContain(
      "this tool's ordering agrees with the build's on 84% of the 4371 route pairs both orderings place, across 94 routes",
    );
    // The figure a rank correlation cannot carry: a pair counts the same at 1 kB and at 800.
    expect(report).toContain(
      "the pairs it places differently are 15 kB apart, against 41 kB for the pairs it agrees on",
    );
    expect(report).toContain("26 routes carry no recorded figure");
    expect(report).toContain("/odd 2 by modules, 40 by bytes");
    expect(report).toContain("200 kB first load, per the build");
  });

  it("caps the routes it lists and counts the remainder", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      url: `/r${i}`,
      modules: new Set([`m${i}`]),
      filePathRoutes: [],
      entries: [],
    }));
    const report = renderReport(
      { ...WEIGHTED, weights: { urlSource: "build" as const, routes: many } },
      { colour: false, version: "16.3.0", projectRoot: "/project" },
    );
    expect(report).toContain("and 4 more routes");
  });

  it("omits the section when there are no routes at all", () => {
    const report = renderReport(RESULT, {
      colour: false,
      version: "16.3.0",
      projectRoot: "/project",
    });
    expect(report).not.toContain("Client weight");
  });
});

describe("the not-evaluated breakdown", () => {
  it("should name each reason with its count when there is more than one", () => {
    const lines = renderReport(
      {
        ...RESULT,
        notEvaluated: 9,
        silence: { evaluated: 2, abstained: 5, delegated: 1, unwritten: 1 },
      },
      OPTIONS,
    );
    expect(lines).toContain(
      "  9 had no verdict: 5 abstained, 1 not yet written, 1 suggested on another entry, 2 evaluated and unmatched",
    );
  });

  it("should not repeat the total when every silent entry shares one reason", () => {
    const lines = renderReport(
      {
        ...RESULT,
        notEvaluated: 4,
        silence: { evaluated: 0, abstained: 4, delegated: 0, unwritten: 0 },
      },
      OPTIONS,
    );
    expect(lines).toContain("  4 had no verdict, abstained");
  });

  it("should leave the flag and build reasons out of the breakdown", () => {
    const lines = renderReport(
      {
        ...RESULT,
        notEvaluated: 5,
        skippedForFlag: 1,
        needingBuild: 2,
        silence: { evaluated: 0, abstained: 2, delegated: 0, unwritten: 0 },
      },
      OPTIONS,
    );
    expect(lines).toContain("  2 had no verdict, abstained");
  });
});

describe("packages that are not installed", () => {
  it("should name them as a fact about the installation, not as a limit on the scan", () => {
    const lines = renderReport(
      {
        ...RESULT,
        missingPackages: [{ name: "@aws-appsync/utils", declared: "no", references: 118 }],
      },
      OPTIONS,
    );
    expect(lines).toContain(
      "  118 imports name 1 package that is not installed — @aws-appsync/utils — 1 of them declared nowhere in the manifest",
    );
  });

  it("should say an install would resolve them when the manifest declares every one", () => {
    const lines = renderReport(
      {
        ...RESULT,
        missingPackages: [{ name: "left-pad", declared: "yes", references: 2 }],
      },
      OPTIONS,
    );
    expect(lines).toContain(
      "  2 imports name 1 package that is not installed — left-pad — each declared in the manifest, so an install would resolve them",
    );
  });

  it("should agree the wording with a count above one", () => {
    const lines = renderReport(
      {
        ...RESULT,
        missingPackages: [
          { name: "left-pad", declared: "yes", references: 2 },
          { name: "right-pad", declared: "yes", references: 1 },
        ],
      },
      OPTIONS,
    );
    expect(lines).toContain(
      "  3 imports name 2 packages that are not installed — left-pad, right-pad — each declared in the manifest, so an install would resolve them",
    );
  });

  it("should print nothing when none is missing", () => {
    expect(renderReport({ ...RESULT, missingPackages: [] }, OPTIONS)).not.toContain(
      "not installed",
    );
  });
});

/**
 * A manifest half-read is not a manifest read. Next stopped writing `renderingMode` outside PPR
 * and every entry of every build without it was discarded without a word, which inverted the
 * rendering-mode contrast for as long as nobody looked at it.
 */
describe("entries the build wrote in a shape this tool does not read", () => {
  const reportWith = (unreadableEntries: number) =>
    renderReport(
      {
        ...RESULT,
        contrast: { ...EMPTY_CONTRAST, buildId: "abc123", checked: 1, unreadableEntries },
      },
      OPTIONS,
    );

  it("should disclose them rather than discarding them in silence", () => {
    expect(reportWith(4)).toContain(
      "4 entries of the build's manifests were written in a shape this tool does not read",
    );
  });

  it("should agree with the count where there is one", () => {
    const report = reportWith(1);
    expect(report).toContain(
      "1 entry of the build's manifests was written in a shape this tool does not read",
    );
    expect(report).not.toContain("entries of the build");
  });

  it("should say nothing where every entry read", () => {
    expect(reportWith(0)).not.toContain("shape this tool does not read");
  });
});

describe("unclaimed build entries read as what they are", () => {
  const reportWith = (unjoined: { metadata: number; framework: number; unexplained: number }) =>
    renderReport(
      {
        ...RESULT,
        contrast: {
          findings: [],
          checked: 1,
          unanswered: { absentRoute: 0, undecidedMode: 0 },
          withdrawn: 0,
          unreadableEntries: 0,
          buildId: "abc123",
          join: { routes: [], unjoinedRoutes: 0, unjoined, disagreements: [] },
        },
      },
      OPTIONS,
    );

  it("should report only the unexplained ones as a gap", () => {
    const report = reportWith({ metadata: 6, framework: 2, unexplained: 1 });
    expect(report).toContain("1 route of its own this tool did not claim");
    expect(report).toContain("6 metadata routes it serves under keys of their own");
    expect(report).toContain("2 routes Next.js generates rather than the project");
  });

  it("should print no gap when every unclaimed entry is explained", () => {
    const report = reportWith({ metadata: 6, framework: 2, unexplained: 0 });
    expect(report).not.toContain("did not claim");
    expect(report).toContain("6 metadata routes it serves under keys of their own");
  });

  /** The pronoun and the key agree with the count, not only the noun in front of them. */
  it("should name a single metadata route in the singular throughout", () => {
    const report = reportWith({ metadata: 1, framework: 0, unexplained: 0 });
    expect(report).toContain("1 metadata route it serves under a key of its own");
    expect(report).not.toContain("their own");
  });

  it("should print nothing at all when there are none", () => {
    const report = reportWith({ metadata: 0, framework: 0, unexplained: 0 });
    expect(report).not.toContain("did not claim");
    expect(report).not.toContain("metadata route");
    expect(report).not.toContain("Next.js generates");
  });
});

describe("an unanswered claim says why", () => {
  const reportWith = (unanswered: { absentRoute: number; undecidedMode: number }) =>
    renderReport(
      {
        ...RESULT,
        contrast: {
          findings: [],
          checked: 1,
          unanswered,
          withdrawn: 0,
          unreadableEntries: 0,
          buildId: "abc123",
          join: {
            routes: [],
            unjoinedRoutes: 0,
            unjoined: { metadata: 0, framework: 0, unexplained: 0 },
            disagreements: [],
          },
        },
      },
      OPTIONS,
    );

  it("should name a route the build's mapping does not list", () => {
    expect(reportWith({ absentRoute: 1, undecidedMode: 0 })).toContain(
      "1 claim about a route the build's own mapping does not list",
    );
  });

  it("should name partial prerendering as settling neither way", () => {
    expect(reportWith({ absentRoute: 0, undecidedMode: 2 })).toContain(
      "2 claims the build answered with partial prerendering, which settles neither way",
    );
  });

  it("should state both when both happened", () => {
    const report = reportWith({ absentRoute: 1, undecidedMode: 1 });
    expect(report).toContain("mapping does not list");
    expect(report).toContain("partial prerendering");
  });

  it("should say nothing when every claim was settled", () => {
    const report = reportWith({ absentRoute: 0, undecidedMode: 0 });
    expect(report).not.toContain("mapping does not list");
    expect(report).not.toContain("partial prerendering");
  });
});

describe("the defaults with no option page", () => {
  it("should state how many the comparison walked past", () => {
    const walked = { ...RESULT, constraintsWithoutEntry: 10 };
    expect(renderReport(walked, OPTIONS)).toContain(
      "10 framework defaults have no option page to report against",
    );
  });

  it("should state the figure even when it is zero", () => {
    expect(renderReport(RESULT, OPTIONS)).toContain(
      "every framework default has an option page to report against",
    );
  });

  it("should state it as a count, never as a share or a grade", () => {
    const output = renderReport({ ...RESULT, constraintsWithoutEntry: 10 }, OPTIONS);
    const line = output.split("\n").find((text) => text.includes("no option page")) ?? "";
    expect(line).not.toMatch(/%|score|severity|coverage|failed/i);
  });
});

describe("the readings a check could not make", () => {
  const UNREAD = [
    { subject: "redirects", reason: "'redirects' is not written as a function this can read" },
    {
      subject: "rewrites",
      reason: "'rewrites' returns a value this cannot read as a list of rules",
    },
  ];

  it("should name each option and what the reader saw", () => {
    const output = renderReport({ ...RESULT, constraintsUnread: UNREAD }, OPTIONS);
    expect(output).toContain(
      "a documented constraint went unchecked: 'redirects' is not written as a function this can read",
    );
    expect(output).toContain(
      "a documented constraint went unchecked: 'rewrites' returns a value this cannot read as a list of rules",
    );
  });

  it("should say nothing where every option was read", () => {
    expect(renderReport(RESULT, OPTIONS)).not.toContain("went unchecked");
  });

  it("should print the reason beside the figure it explains", () => {
    // The checked figure is what the reason accounts for, so a reader meets them together.
    const lines = renderReport({ ...RESULT, constraintsUnread: UNREAD }, OPTIONS).split("\n");
    const checked = lines.findIndex((line) => line.includes("documented constraint"));
    const first = lines.findIndex((line) => line.includes("went unchecked"));
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(first).toBe(checked + 1);
  });

  it("should report the shape, never a fault in the project", () => {
    const output = renderReport({ ...RESULT, constraintsUnread: UNREAD }, OPTIONS);
    const line = output.split("\n").find((text) => text.includes("went unchecked")) ?? "";
    expect(line).not.toMatch(/should|must|invalid|wrong|error|fix/i);
  });

  it("should still name them where nothing at all could be checked", () => {
    // The checked figure is only printed above zero, so at zero these lines are the whole account
    // of why. Dropping them with the figure would leave the emptiest report saying the least.
    const output = renderReport(
      { ...RESULT, constraintsChecked: 0, constraintsUnread: UNREAD },
      OPTIONS,
    );
    expect(output).not.toContain("documented constraints checked");
    expect(output).toContain("went unchecked: 'redirects'");
    expect(output).toContain("went unchecked: 'rewrites'");
  });

  it("should print one line per subject, whether or not the subject is an option", () => {
    // The count, not only the content: the last time this channel gained a source it printed one
    // cause twice, and an assertion on what the lines said would have passed.
    const mixed = [
      ...UNREAD,
      {
        subject: "typescript",
        reason:
          "the installed typescript could not be read, so the combination it is half of was not checked",
      },
    ];
    const lines = renderReport({ ...RESULT, constraintsUnread: mixed }, OPTIONS)
      .split("\n")
      .filter((line) => line.includes("went unchecked"));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("the installed typescript could not be read");
  });
});

describe("the findings view", () => {
  const BARE = RESULT.entries[0];
  if (BARE === undefined) throw new Error("expected the shared fixture to carry a used entry");
  const WOULD_APPLY = RESULT.entries[1];
  if (WOULD_APPLY === undefined)
    throw new Error("expected the shared fixture to carry a suggestion");
  const UNMATCHED = WITH_UNMATCHED.entries[0];
  if (UNMATCHED === undefined) throw new Error("expected the unmatched fixture to carry an entry");
  const LEAKING = WITH_LEAKS.entries[0];
  if (LEAKING === undefined) throw new Error("expected the leak fixture to carry an entry");

  describe("what counts as a finding", () => {
    it("should accept every entry in the would-apply bucket", () => {
      expect(hasFinding(WOULD_APPLY)).toBe(true);
    });

    it("should reject a used entry carrying nothing", () => {
      expect(hasFinding(BARE)).toBe(false);
    });

    it("should accept a used entry carrying an unmatched declaration", () => {
      expect(hasFinding(UNMATCHED)).toBe(true);
    });

    it("should accept a used entry carrying a boundary leak", () => {
      expect(hasFinding(LEAKING)).toBe(true);
    });

    it("should accept a used entry carrying a contradicted constraint", () => {
      const entry = {
        ...BARE,
        constraints: { note: "the framework applies these anyway", items: [] },
      };
      expect(hasFinding(entry)).toBe(true);
    });

    it("should accept a used entry that would also apply elsewhere", () => {
      const entry = {
        ...BARE,
        alsoWouldApply: { evidence: ["app/other.tsx"], gain: "what adopting it buys" },
      };
      expect(hasFinding(entry)).toBe(true);
    });

    /**
     * The drift guard. A fifth channel added to `ClassifiedEntry` and not to `FINDING_CHANNELS`
     * would not fail anything else here: the view would render without it and simply never show
     * that finding. This fails instead, and names the field that was added.
     */
    it("should read every channel a classified entry can carry", () => {
      expect([...FINDING_CHANNELS]).toEqual([
        "alsoWouldApply",
        "unmatched",
        "leaks",
        "constraints",
      ]);
    });
  });

  describe("what it prints", () => {
    it("should omit a used entry that carries nothing", () => {
      const output = renderFindings(RESULT, OPTIONS);
      expect(output).not.toContain("page.js");
    });

    it("should keep a would-apply entry with the evidence that makes it apply", () => {
      const output = renderFindings(RESULT, OPTIONS);
      expect(output).toContain("default.js");
      expect(output).toContain("app/@modal");
      expect(output).toContain("these parallel slots 404 on a hard navigation without a default");
    });

    it("should keep a used entry's channel and drop the paths where it is used", () => {
      const output = renderFindings(WITH_UNMATCHED, OPTIONS);
      expect(output).toContain("cacheTag");
      expect(output).toContain("public-news");
      expect(output).toContain("app/news/page.tsx");
      // The declaration's own file is the finding; app/a.ts is the inventory under it.
      expect(output).not.toContain("app/a.ts");
    });

    it("should not print the client weight section", () => {
      const weighted = {
        ...RESULT,
        weights: { routes: [{ url: "/dashboard", modules: new Set(["a.tsx"]) }] },
      } as unknown as CoverageResult;
      expect(renderReport(weighted, OPTIONS)).toContain("Client weight");
      expect(renderFindings(weighted, OPTIONS)).not.toContain("Client weight");
    });

    it("should keep the build contrast section, including its empty line", () => {
      const output = renderFindings(RESULT, OPTIONS);
      expect(output).toContain("Build contrast");
      expect(output).toContain("nothing contrasted");
    });
  });

  describe("what it discloses", () => {
    it("should say how many entries carry a finding, of how many examined", () => {
      expect(renderFindings(RESULT, OPTIONS)).toContain("1 entry carries a finding, of 2 examined");
    });

    it("should say how many entries it did not print", () => {
      expect(renderFindings(RESULT, OPTIONS)).toContain(
        "1 entry is not printed here: nothing is attached to them",
      );
    });

    it("should keep the withheld-heuristics line and the flag that reveals them", () => {
      const withheld = { ...RESULT, withheldHeuristics: 11 };
      expect(renderFindings(withheld, OPTIONS)).toContain(
        "11 opt-in suggestions withheld; run with --strict to see them",
      );
    });

    it("should point at the full report", () => {
      expect(renderFindings(RESULT, OPTIONS)).toContain("run without --findings");
    });

    it("should say it found nothing rather than going silent", () => {
      const quiet = { ...RESULT, entries: [BARE] };
      const output = renderFindings(quiet, OPTIONS);
      expect(output).toContain("no entry carries a finding, of 1 entry examined");
      expect(output).toContain("run without --findings");
    });

    it("should never emit a severity either", () => {
      const output = renderFindings(WITH_LEAKS, OPTIONS).toLowerCase();
      for (const banned of ["severity:", "score:", "grade", "/10", "must fix", "is wrong"]) {
        expect(output).not.toContain(banned);
      }
    });
  });

  /**
   * The guard against the two renderings drifting apart. Every indented line the findings view
   * prints — entries, domains, channels, chains — has to be a line the full report prints too, so
   * one finding cannot reach a reader worded two ways depending on the flag they passed. The
   * header and the footer are excluded because they are the view describing itself, not a finding.
   */
  describe("agreement with the full report", () => {
    const findingLines = (result: CoverageResult): string[] => {
      const output = renderFindings(result, OPTIONS);
      const upToContrast = output.slice(0, output.indexOf("Build contrast"));
      return upToContrast.split("\n").filter((line) => line.startsWith("  "));
    };

    it("should word every finding exactly as the full report does", () => {
      for (const result of [RESULT, WITH_UNMATCHED, WITH_LEAKS]) {
        const full = renderReport(result, OPTIONS);
        for (const line of findingLines(result)) expect(full).toContain(line);
      }
    });
  });
});

const NOTE =
  "these files declare the client directive and show none of the documented reasons for it";

const clientEntryWith = (
  items: readonly { module: string; exclusiveModules: number }[] | undefined,
): CoverageResult => ({
  ...RESULT,
  preset: items === undefined ? "default" : "strict",
  entries: [
    {
      id: "directives/use-client",
      domain: "directives",
      title: "use client",
      docs: DOCS,
      bucket: "used",
      evidence: ["app/panel/Filtros.tsx"],
      ...(items === undefined ? {} : { directivesWithoutReason: { note: NOTE, items } }),
    },
  ],
  clientClosure: 12,
  ...(items === undefined
    ? { withheldHeuristics: 1 }
    : { clientDirectivesWithoutReason: items.length }),
});

describe("a directive the file does not use", () => {
  const reported = clientEntryWith([
    { module: "app/informe/Aviso.tsx", exclusiveModules: 14 },
    { module: "app/aviso/Leaf.tsx", exclusiveModules: 0 },
  ]);

  it("should list the files beneath the entry, with the count each one carries", () => {
    const output = renderReport(reported, OPTIONS);
    expect(output).toContain(NOTE);
    expect(output).toContain("app/informe/Aviso.tsx");
    expect(output).toContain("14 modules reach the client only through it");
    expect(output).toContain("0 modules reach the client only through it");
  });

  it("should leave the entry in the bucket it was in", () => {
    const output = renderReport(reported, OPTIONS);
    expect(output).toContain("Used");
    expect(output).not.toContain("Would apply");
  });

  it("should claim nothing about the bundle or the file's directive", () => {
    const output = renderReport(reported, OPTIONS).toLowerCase();
    for (const banned of [
      "remove the",
      "should be removed",
      "would shrink",
      "kb",
      "bytes",
      "is wrong",
    ]) {
      expect(output).not.toContain(banned);
    }
  });

  it("should state the count beside the closure size", () => {
    const output = renderReport(reported, OPTIONS);
    expect(output).toContain("12 files are on the client side of the boundary");
    expect(output).toContain("2 client entries declare the directive and show none");
  });

  it("should say the examination ran and found none, without a heading over nothing", () => {
    const output = renderReport(clientEntryWith([]), OPTIONS);
    expect(output).toContain("0 client entries declare the directive and show none");
    expect(output).not.toContain(NOTE);
  });

  it("should count the channel among the withheld heuristics under the default preset", () => {
    const output = renderReport(clientEntryWith(undefined), OPTIONS);
    expect(output).toContain("1 opt-in suggestion withheld; run with --strict to see them");
    expect(output).not.toContain(NOTE);
    expect(output).not.toContain("declare the directive and show none");
  });
});

/**
 * A reopened condition argues from a shape somebody measured as not arguing. The reader who asked
 * for it with `--strict` is told which, so the finding can be weighed rather than taken on trust.
 */
describe("the refusal a reopened condition replaced", () => {
  const SUGGESTION = RESULT.entries[1];
  if (SUGGESTION === undefined)
    throw new Error("expected the shared fixture to carry a suggestion");

  const REOPENED = {
    condition: "an option set to the value the framework already applies",
    outcome: "the configuration restating a default is not an adoption gap",
  } as const;

  const withReopening = (entry = SUGGESTION): CoverageResult => ({
    ...RESULT,
    entries: [{ ...entry, reopenedFrom: REOPENED }],
  });

  it("should print the condition that was tried and what refused it", () => {
    const output = renderReport(withReopening(), OPTIONS);
    expect(output).toContain(`once refused: ${REOPENED.condition}, and ${REOPENED.outcome}`);
  });

  it("should print it beneath the gain, not in place of it", () => {
    const lines = renderReport(withReopening(), OPTIONS).split("\n");
    const gain = lines.findIndex((line) => line.includes("a default file gives the slot"));
    const refusal = lines.findIndex((line) => line.includes("once refused:"));
    expect(gain).toBeGreaterThan(-1);
    expect(refusal).toBe(gain + 2);
  });

  it("should say nothing where the condition reopened nothing", () => {
    expect(renderReport(RESULT, OPTIONS)).not.toContain("once refused:");
  });

  /**
   * A used entry prints no gain, because a page reference on an API the project already uses is a
   * line nobody asked for. The refusal hangs off the argument, so it goes quiet with it.
   */
  it("should stay quiet on an entry with nothing to suggest", () => {
    const used = RESULT.entries[0];
    if (used === undefined) throw new Error("expected the shared fixture to carry a used entry");
    expect(renderReport(withReopening(used), OPTIONS)).not.toContain("once refused:");
  });
});

/**
 * The count sits beside the withheld one because it qualifies it: a reader deciding whether to
 * trust the strict preset is owed how much of it argues from a shape a measurement refused.
 */
describe("how much of the surface is reopened", () => {
  const reopened = (count: number): CoverageResult => ({ ...RESULT, reopenedConditions: count });

  it("should state the figure in the disclosure", () => {
    expect(renderReport(reopened(3), OPTIONS)).toContain(
      "3 conditions argue from a shape a measurement refused",
    );
  });

  it("should agree with itself on one", () => {
    expect(renderReport(reopened(1), OPTIONS)).toContain(
      "1 condition argues from a shape a measurement refused",
    );
  });

  it("should say nothing where no condition was reopened", () => {
    expect(renderReport(RESULT, OPTIONS)).not.toContain("a shape a measurement refused");
  });
});

describe("the release a verdict was measured against", () => {
  const OLDER = { ...RESULT, verdictsAgainstAnOlderRelease: 3 };
  const NEWER = { ...RESULT, verdictsAgainstANewerRelease: 2 };

  it("should say nothing where every verdict names the release in play", () => {
    for (const output of [renderReport(RESULT, OPTIONS), renderFindings(RESULT, OPTIONS)]) {
      expect(output).not.toContain("measured against an older release");
      expect(output).not.toContain("measured against a newer release");
    }
  });

  it("should name the direction, and only the one that happened", () => {
    const older = renderReport(OLDER, OPTIONS);
    expect(older).toContain(
      "3 verdicts were measured against an older release than the one installed",
    );
    expect(older).not.toContain("newer release");

    const newer = renderReport(NEWER, OPTIONS);
    expect(newer).toContain(
      "2 verdicts were measured against a newer release than the one installed",
    );
    expect(newer).not.toContain("older release");
  });

  /** The two renderings state findings identically, so a sentence added to one belongs in both. */
  it("should state it in the findings view too", () => {
    expect(renderFindings(OLDER, OPTIONS)).toContain("measured against an older release");
    expect(renderFindings(NEWER, OPTIONS)).toContain("measured against a newer release");
  });

  it("should say both where the catalog straddles the installed release", () => {
    const both = { ...RESULT, verdictsAgainstAnOlderRelease: 1, verdictsAgainstANewerRelease: 1 };
    const output = renderReport(both, OPTIONS);
    expect(output).toContain("1 verdict was measured against an older release");
    expect(output).toContain("1 verdict was measured against a newer release");
  });
});

describe("the sentence for a root that declares nothing", () => {
  it("should name the apps below it without calling it a workspace root", () => {
    const text = renderStop(
      {
        kind: "apps-below",
        from: "/repo",
        apps: [
          { directory: "/repo/frontend", declares: "16.3.4" },
          { directory: "/repo/web", declares: "^16.3" },
        ],
      },
      false,
    );
    expect(text).toContain("No Next.js project at /repo");
    expect(text).toContain("no workspace declares one");
    expect(text).toContain("2 Next.js apps sit below it");
    expect(text).toContain("/repo/frontend (next 16.3.4)");
    expect(text).toContain("/repo/web (next ^16.3)");
    // Nothing here declares a workspace, so the directory has not earned the noun.
    expect(text).not.toContain("workspace root");
  });

  it("should count and conjugate one app in the singular", () => {
    const text = renderStop(
      { kind: "apps-below", from: "/repo", apps: [{ directory: "/repo/frontend" }] },
      false,
    );
    expect(text).toContain("1 Next.js app sits below it");
    expect(text).toContain("analyse it:");
    expect(text).toContain("/repo/frontend");
    // No range where the manifest named none, rather than an empty parenthesis.
    expect(text).not.toContain("(next ");
  });

  it("should tell the reader to choose where there are several", () => {
    const text = renderStop(
      {
        kind: "apps-below",
        from: "/repo",
        apps: [{ directory: "/repo/frontend" }, { directory: "/repo/web" }],
      },
      false,
    );
    expect(text).toContain("analyse one of them:");
  });
});

describe("the sentence for a workspace root", () => {
  it("should name the apps it found and where they are", () => {
    const text = renderStop(
      {
        kind: "workspace-root",
        root: "/repo",
        apps: [
          { directory: "/repo/apps/admin", declares: "16.3.0" },
          { directory: "/repo/apps/donor", declares: "^16.2" },
        ],
      },
      false,
    );
    expect(text).toContain("/repo is a workspace root, not a project");
    expect(text).toContain("2 Next.js apps");
    expect(text).toContain("/repo/apps/admin (next 16.3.0)");
    expect(text).toContain("/repo/apps/donor (next ^16.2)");
  });

  it("should count one app in the singular", () => {
    const text = renderStop(
      { kind: "workspace-root", root: "/repo", apps: [{ directory: "/repo/apps/admin" }] },
      false,
    );
    expect(text).toContain("1 Next.js app;");
    expect(text).toContain("/repo/apps/admin");
    // No range where the manifest named none, rather than an empty parenthesis.
    expect(text).not.toContain("(next ");
  });

  /** "Analyse one of them" points at a list of one; the instruction names what it points at. */
  it("should tell the reader to analyse the app where there is only one", () => {
    const one = renderStop(
      { kind: "workspace-root", root: "/repo", apps: [{ directory: "/repo/apps/admin" }] },
      false,
    );
    expect(one).toContain("analyse it:");
    expect(one).not.toContain("one of them");
    const several = renderStop(
      {
        kind: "workspace-root",
        root: "/repo",
        apps: [{ directory: "/repo/apps/admin" }, { directory: "/repo/apps/donor" }],
      },
      false,
    );
    expect(several).toContain("analyse one of them:");
  });

  it("should leave the other two reasons reading as they did", () => {
    expect(renderStop({ kind: "no-project", from: "/x" }, false)).toContain(
      "No Next.js project found at or above /x.",
    );
    expect(
      renderStop({ kind: "no-app-router", root: "/x", hasPagesRouter: true }, false),
    ).toContain("uses the Pages Router");
  });
});

describe("what the report says about linked workspace packages", () => {
  it("should say nothing where the project links to none", () => {
    expect(renderReport(RESULT, OPTIONS)).not.toContain("linked workspace package");
  });

  it("should state what it read and what it could not", () => {
    const linked = { ...RESULT, linkedPackages: { scanned: 2, unmatched: 1 } };
    const output = renderReport(linked, OPTIONS);
    expect(output).toContain("2 linked workspace packages were read as part of this project");
    expect(output).toContain("1 workspace dependency names no member of the workspace");
  });

  /**
   * The findings view carries the disclosures about what the run could not do, and not the ones
   * that are merely informative — the same rule the withheld-heuristics line follows.
   */
  it("should carry the unread half into the findings view and not the read half", () => {
    const linked = { ...RESULT, linkedPackages: { scanned: 2, unmatched: 1 } };
    const output = renderFindings(linked, OPTIONS);
    expect(output).toContain("1 workspace dependency names no member of the workspace");
    expect(output).not.toContain("read as part of this project");
  });
});

describe("a segment still exporting what the configuration removed", () => {
  const WITH_REMOVED = {
    ...RESULT,
    constraintsContradicted: 1,
    entries: [
      {
        id: "config/next-config-js/cacheComponents",
        domain: "config",
        title: "cacheComponents",
        docs: DOCS,
        bucket: "used" as const,
        evidence: ["next.config.ts"],
        constraints: {
          note: "the documentation says this option removes these route segment configs",
          items: [
            {
              kind: "segment-config-removed" as const,
              entry: "config/next-config-js/cacheComponents",
              option: "cacheComponents",
              segments: [
                { file: "app/a/page.tsx", exported: "dynamic" },
                { file: "app/b/page.tsx", exported: "revalidate" },
                { file: "app/c/page.tsx", exported: "fetchCache" },
                { file: "app/d/page.tsx", exported: "dynamicParams" },
              ],
              consequence: "next build stops on each of them",
              source: "next.config.ts",
            },
          ],
        },
      },
    ],
  };

  it("should name the segments and what each of them exports", () => {
    const output = renderReport(WITH_REMOVED, OPTIONS);
    expect(output).toContain("app/a/page.tsx exports dynamic");
    expect(output).toContain("app/b/page.tsx exports revalidate");
    expect(output).toContain("and 1 more");
  });

  it("should report the consequence, never a fault in the project", () => {
    const output = renderReport(WITH_REMOVED, OPTIONS);
    const line = output.split("\n").find((text) => text.includes("next build stops")) ?? "";
    expect(line).not.toMatch(/should|must|invalid|wrong|fix/i);
  });
});
