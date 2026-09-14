import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/build.js";
import { REFUSED_WHEN_THE_RULE_CHANGED } from "../catalog/reopened.js";
import type { PredicateContext, PredicateSet } from "../catalog/types.js";
import { match, NO_MATCH, suggest } from "../catalog/types.js";
import { readNextConfig } from "../collect/config.js";
import type { SurfaceDerivation, SurfaceEntry } from "../collect/docs.js";
import { buildGraph } from "../collect/graph.js";
import type { Ledger } from "../collect/ledger.js";
import { EMPTY_LEDGER } from "../collect/ledger.js";
import type { BuildOutput } from "../collect/output.js";
import { EMPTY_JOIN, NO_WEIGHTS } from "../collect/output.js";
import type { Bundler, ProjectContext } from "../collect/project.js";
import type { RouteTree } from "../collect/routes.js";
import { MissingEvidenceError } from "../errors.js";
import { resolved, unresolved } from "../types.js";
import { classify } from "./classify.js";

const ROOT = "/project";

/** The reason a set with no condition now has to carry. */
const SILENT = { kind: "unwritten", why: "nothing written for this test entry" } as const;

function surfaceOf(ids: readonly string[]): SurfaceDerivation {
  const entries: SurfaceEntry[] = ids.map((id) => ({
    id,
    domain: "file-conventions",
    title: id,
    relatedLinks: [],
    docPath: `/docs/${id}.md`,
    frontmatterFailed: false,
    docRelativePath: "",
    docUrl: "",
    adoptable: true,
  }));
  return { status: "available", referenceRoot: "/docs", entries };
}

const emptyTree: RouteTree = {
  root: {
    dirName: "",
    kind: "static",
    urlPath: "/",
    directory: `${ROOT}/app`,
    conventions: [],
    colocated: [],
    children: [],
  },
  nodes: [],
  issues: [],
  implicitChildrenSlot: true,
};

function contextWith(flagsOn: readonly string[] = []): PredicateContext {
  const project = {
    root: ROOT,
    appDirectory: { path: `${ROOT}/app` },
    installedNext: undefined,
    version: resolved("16.3.0"),
    config: undefined,
    declaredPackages: resolved(new Set<string>()),
    bundlers: resolved(new Set<Bundler>(["turbopack"])),
    typeScriptMajor: unresolved("no installed typescript in this fixture"),
    pageExtensions: resolved(["tsx"]),
  } satisfies ProjectContext;
  const sources = {
    files: [],
    byPath: new Map(),
    resolution: { internal: 0, external: 0, unresolved: 0, assets: 0, missingPackages: [] },
    linked: { scanned: 0, unmatched: 0 },
  };
  return {
    project,
    tree: emptyTree,
    sources,
    graph: buildGraph(sources),
    isFlagEnabled: (flag) => flagsOn.includes(flag),
    // No build is read in these tests: every predicate here answers from source alone.
    build: unresolved("no build was read"),
    join: EMPTY_JOIN,
  };
}

function classifyOne(predicate: PredicateSet, flagsOn: readonly string[] = []) {
  const catalog = buildCatalog(surfaceOf([predicate.id]), [predicate]);
  return classify(catalog, contextWith(flagsOn));
}

const OPT_IN: PredicateSet = {
  id: "functions/revalidateTag",
  cost: "AST",
  detectUsed: () => NO_MATCH,
  wouldApply: () => suggest(["/project/app/actions.ts"], "observed, not proven", "what it buys"),
  wouldApplyPreset: "strict",
};

describe("bucket resolution", () => {
  it("should prefer used over not-applicable when both match", () => {
    const result = classifyOne({
      id: "file-conventions/page",
      cost: "FS",
      noSuggestion: SILENT,
      detectUsed: () => match([`${ROOT}/app/page.tsx`]),
      notApplicable: () => match([`${ROOT}/app`]),
    });
    expect(result.entries[0]?.bucket).toBe("used");
  });

  it("should fall through to would-apply when nothing else matches", () => {
    const result = classifyOne({
      id: "file-conventions/page",
      cost: "FS",
      detectUsed: () => NO_MATCH,
      wouldApply: () => suggest([`${ROOT}/app`], "because", "what it buys"),
    });
    expect(result.entries[0]?.bucket).toBe("would-apply");
    expect(result.entries[0]?.note).toBe("because");
  });

  it("should report not-evaluated rather than dropping an entry with no verdict", () => {
    const result = classifyOne({
      id: "file-conventions/page",
      cost: "FS",
      noSuggestion: SILENT,
      detectUsed: () => NO_MATCH,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.bucket).toBe("not-evaluated");
  });

  it("should put a disabled flag entry in not-evaluated, never in would-apply", () => {
    const result = classifyOne({
      id: "file-conventions/forbidden",
      cost: "FS",
      requiredFlag: "experimental.authInterrupts",
      detectUsed: () => match([`${ROOT}/app/forbidden.tsx`]),
      wouldApply: () => suggest([`${ROOT}/app`], "because", "what it buys"),
    });
    expect(result.entries[0]?.bucket).toBe("not-evaluated");
    expect(result.entries[0]?.skippedForFlag).toBe("experimental.authInterrupts");
  });

  it("should evaluate a flag-gated entry once its flag is on", () => {
    const result = classifyOne(
      {
        id: "file-conventions/forbidden",
        cost: "FS",
        noSuggestion: SILENT,
        requiredFlag: "experimental.authInterrupts",
        detectUsed: () => match([`${ROOT}/app/forbidden.tsx`]),
      },
      ["experimental.authInterrupts"],
    );
    expect(result.entries[0]?.bucket).toBe("used");
  });
});

describe("evidence contract", () => {
  it("should refuse a match that carries no evidence", () => {
    expect(() =>
      classifyOne({
        id: "file-conventions/page",
        cost: "FS",
        noSuggestion: SILENT,
        detectUsed: () => ({ matched: true, evidence: [] }),
      }),
    ).toThrow(MissingEvidenceError);
  });

  it("should report evidence relative to the project root, sorted", () => {
    const result = classifyOne({
      id: "file-conventions/page",
      cost: "FS",
      noSuggestion: SILENT,
      detectUsed: () => match([`${ROOT}/app/b.tsx`, `${ROOT}/app/a.tsx`]),
    });
    expect(result.entries[0]?.evidence).toEqual(["app/a.tsx", "app/b.tsx"]);
  });

  it("should name the same file alike whether or not the root ends in a separator", () => {
    const predicate: PredicateSet = {
      id: "file-conventions/page",
      cost: "FS",
      noSuggestion: SILENT,
      detectUsed: () => match([`${ROOT}/proxy.ts`]),
    };
    const catalog = buildCatalog(surfaceOf([predicate.id]), [predicate]);
    const context = contextWith();
    const trailing = {
      ...context,
      project: { ...context.project, root: `${ROOT}/` },
    } satisfies PredicateContext;
    expect(classify(catalog, trailing).entries[0]?.evidence).toEqual(["proxy.ts"]);
  });
});

describe("usage ratio", () => {
  it("should exclude not-applicable and not-evaluated from both terms", () => {
    const catalog = buildCatalog(surfaceOf(["a", "b", "c", "d"]), [
      { id: "a", cost: "FS", detectUsed: () => match(["/x"]), noSuggestion: SILENT },
      {
        id: "b",
        cost: "FS",
        detectUsed: () => NO_MATCH,
        wouldApply: () => suggest(["/y"], "because", "what it buys"),
      },
      {
        id: "c",
        cost: "FS",
        detectUsed: () => NO_MATCH,
        notApplicable: () => match(["/z"]),
        noSuggestion: SILENT,
      },
      { id: "d", cost: "FS", detectUsed: () => NO_MATCH, noSuggestion: SILENT },
    ]);
    const result = classify(catalog, contextWith());
    expect(result.used).toBe(1);
    expect(result.evaluated).toBe(2);
    expect(result.notApplicable).toBe(1);
    expect(result.notEvaluated).toBe(1);
  });

  it("should count the surface this tool cannot detect", () => {
    const catalog = buildCatalog(surfaceOf(["a", "b"]), [
      { id: "a", cost: "FS", detectUsed: () => match(["/x"]), noSuggestion: SILENT },
    ]);
    expect(classify(catalog, contextWith()).documentedNotCovered).toBe(1);
  });
});

/**
 * The client directive's examination is opt-in and runs before classification, so every default
 * run counts it as withheld before any entry's own condition is looked at. Written as a constant
 * rather than folded into each number, so a test about one entry still reads as being about it.
 */
const CHANNEL_WITHHELD = 1;

describe("presets", () => {
  it("should withhold an opt-in heuristic from the default preset", () => {
    const catalog = buildCatalog(surfaceOf([OPT_IN.id]), [OPT_IN]);
    const result = classify(catalog, contextWith(), "default");
    expect(result.entries[0]?.bucket).toBe("not-evaluated");
    expect(result.withheldHeuristics).toBe(CHANNEL_WITHHELD + 1);
    expect(result.preset).toBe("default");
  });

  it("should run an opt-in heuristic under the strict preset", () => {
    const catalog = buildCatalog(surfaceOf([OPT_IN.id]), [OPT_IN]);
    const result = classify(catalog, contextWith(), "strict");
    expect(result.entries[0]?.bucket).toBe("would-apply");
    expect(result.withheldHeuristics).toBe(0);
  });

  it("should default to the conservative preset when none is given", () => {
    const catalog = buildCatalog(surfaceOf([OPT_IN.id]), [OPT_IN]);
    expect(classify(catalog, contextWith()).withheldHeuristics).toBe(CHANNEL_WITHHELD + 1);
  });

  it("should also withhold an opt-in heuristic from a used entry", () => {
    const used: PredicateSet = { ...OPT_IN, detectUsed: () => match(["/project/app/a.ts"]) };
    const catalog = buildCatalog(surfaceOf([used.id]), [used]);
    const result = classify(catalog, contextWith(), "default");
    expect(result.entries[0]?.bucket).toBe("used");
    expect(result.entries[0]?.alsoWouldApply).toBeUndefined();
    expect(result.withheldHeuristics).toBe(CHANNEL_WITHHELD + 1);
  });
});

// One entry, two arguments: one proven and one merely observed. Marking the set opt-in would
// withhold the proven one, and leaving both in the default preset would ship the observed one.
describe("a preset per condition", () => {
  // Declared the way the entry it stands for declares itself: the convention lookup every run pays
  // is `FS`, and the graph belongs to the strict condition, which is what the attribution says. A
  // set claiming the graph on used detection is refused by assembly, so this shape is also the only
  // one a split like this can take.
  const SPLIT: PredicateSet = {
    id: "file-conventions/not-found",
    cost: "FS",
    conditionCost: "GRAFO",
    conditionCostReadBy: "strict",
    detectUsed: () => NO_MATCH,
    wouldApply: () => NO_MATCH,
    wouldApplyStrict: () =>
      suggest(["/project/app/lib/read.ts"], "observed through the graph", "what it buys"),
  };

  it("should run the proven condition under the default preset", () => {
    const proven: PredicateSet = {
      ...SPLIT,
      wouldApply: () => suggest(["/project/app/page.tsx"], "because", "what it buys"),
    };
    const result = classify(buildCatalog(surfaceOf([proven.id]), [proven]), contextWith());
    expect(result.entries[0]?.bucket).toBe("would-apply");
    expect(result.entries[0]?.evidence).toEqual(["app/page.tsx"]);
  });

  it("should withhold only the observed condition under the default preset", () => {
    const result = classify(buildCatalog(surfaceOf([SPLIT.id]), [SPLIT]), contextWith(), "default");
    expect(result.entries[0]?.bucket).toBe("not-evaluated");
    expect(result.withheldHeuristics).toBe(CHANNEL_WITHHELD + 1);
  });

  it("should fall through to the observed condition under the strict preset", () => {
    const result = classify(buildCatalog(surfaceOf([SPLIT.id]), [SPLIT]), contextWith(), "strict");
    expect(result.entries[0]?.bucket).toBe("would-apply");
    expect(result.entries[0]?.evidence).toEqual(["app/lib/read.ts"]);
    expect(result.withheldHeuristics).toBe(0);
  });

  it("should prefer the proven condition when both would hold", () => {
    const both: PredicateSet = {
      ...SPLIT,
      wouldApply: () => suggest(["/project/app/page.tsx"], "because", "what it buys"),
    };
    const result = classify(buildCatalog(surfaceOf([both.id]), [both]), contextWith(), "strict");
    expect(result.entries[0]?.evidence).toEqual(["app/page.tsx"]);
  });

  // A count that only saw fully withheld entries would let the report show one argument while
  // silently holding back another for the same entry.
  it("should count a condition withheld inside an entry that still reports", () => {
    const both: PredicateSet = {
      ...SPLIT,
      wouldApply: () => suggest(["/project/app/page.tsx"], "because", "what it buys"),
    };
    const result = classify(buildCatalog(surfaceOf([both.id]), [both]), contextWith(), "default");
    expect(result.entries[0]?.bucket).toBe("would-apply");
    expect(result.withheldHeuristics).toBe(CHANNEL_WITHHELD + 1);
  });

  it("should count a condition withheld inside an entry reported as used", () => {
    const used: PredicateSet = { ...SPLIT, detectUsed: () => match(["/project/app/a.ts"]) };
    const result = classify(buildCatalog(surfaceOf([used.id]), [used]), contextWith(), "default");
    expect(result.entries[0]?.bucket).toBe("used");
    expect(result.withheldHeuristics).toBe(CHANNEL_WITHHELD + 1);
  });

  it("should carry the observed condition on a used entry under strict", () => {
    const used: PredicateSet = { ...SPLIT, detectUsed: () => match(["/project/app/a.ts"]) };
    const result = classify(buildCatalog(surfaceOf([used.id]), [used]), contextWith(), "strict");
    expect(result.entries[0]?.alsoWouldApply?.evidence).toEqual(["app/lib/read.ts"]);
    expect(result.withheldHeuristics).toBe(0);
  });
});

// A project contradicting a constraint of an API is still using that API. The third finding of
// its kind, after unmatched declarations and boundary leaks, and it obeys the same rule.
describe("contradicted constraints", () => {
  const ENTRY = "file-conventions/parallel-routes";
  const REPORT = {
    checked: 1,
    withoutEntry: 0,
    unread: [],
    findings: [
      {
        entry: ENTRY,
        kind: "slot-mode" as const,
        segment: `${ROOT}/app`,
        staticSlots: [{ slot: "quiet", directory: `${ROOT}/app/@quiet` }],
        cause: "loud",
        causeChain: [`${ROOT}/app/@loud/default.tsx`, `${ROOT}/lib/session.ts`],
        otherDynamic: 0,
      },
    ],
  };
  const used: PredicateSet = {
    id: ENTRY,
    cost: "FS",
    detectUsed: () => match([`${ROOT}/app`]),
    noSuggestion: SILENT,
  };
  const catalogue = () => buildCatalog(surfaceOf([ENTRY]), [used]);

  it("should report the finding under the entry whose docs state the rule", () => {
    const result = classify(catalogue(), contextWith(), "default", EMPTY_LEDGER, undefined, REPORT);
    expect(result.entries[0]?.constraints?.items).toHaveLength(1);
    const first = result.entries[0]?.constraints?.items[0];
    const finding = first?.kind === "slot-mode" ? first : undefined;
    expect(finding?.segment).toBe("app");
    expect(finding?.causeChain).toEqual(["app/@loud/default.tsx", "lib/session.ts"]);
  });

  it("should leave the bucket and every count exactly as they were", () => {
    const without = classify(catalogue(), contextWith());
    const with_ = classify(catalogue(), contextWith(), "default", EMPTY_LEDGER, undefined, REPORT);
    expect(with_.entries[0]?.bucket).toBe("used");
    expect(with_.entries[0]?.bucket).toBe(without.entries[0]?.bucket);
    expect([with_.used, with_.evaluated, with_.notApplicable, with_.notEvaluated]).toEqual([
      without.used,
      without.evaluated,
      without.notApplicable,
      without.notEvaluated,
    ]);
  });

  it("should not attach a finding to an entry it does not belong to", () => {
    const other: PredicateSet = { ...used, id: "file-conventions/page" };
    const result = classify(
      buildCatalog(surfaceOf([other.id]), [other]),
      contextWith(),
      "default",
      EMPTY_LEDGER,
      undefined,
      REPORT,
    );
    expect(result.entries[0]?.constraints).toBeUndefined();
  });

  it("should state what was checked even when nothing is contradicted", () => {
    const result = classify(catalogue(), contextWith(), "default", EMPTY_LEDGER, undefined, {
      checked: 1,
      withoutEntry: 0,
      unread: [],
      findings: [],
    });
    expect(result.constraintsChecked).toBe(1);
    expect(result.constraintsContradicted).toBe(0);
  });
});

describe("documented legacy status", () => {
  function legacyCatalog(predicate: PredicateSet) {
    const surface = surfaceOf([predicate.id]);
    const entries = surface.status === "available" ? surface.entries : [];
    return buildCatalog(
      {
        status: "available",
        referenceRoot: "/docs",
        entries: entries.map((e) => ({ ...e, status: "legacy" })),
      },
      [predicate],
    );
  }

  // The half every case here shares. Kept off `PredicateSet` so a case can spread it and then
  // choose its own half: a silent reason, or a condition.
  //
  // The id is one that answered with no refusal: some
  // of these cases give the set a condition, and assembly refuses one on a refused entry that
  // carries no `reopenedFrom`. What is under test is the legacy status, not the reopening rule.
  const NEVER_USED = {
    id: "file-conventions/mdx-components",
    cost: "FS",
    detectUsed: () => NO_MATCH,
  } as const;
  const NEVER_USED_SILENT: PredicateSet = { ...NEVER_USED, noSuggestion: SILENT };

  it("should dismiss a legacy api the project does not use", () => {
    const result = classify(legacyCatalog(NEVER_USED_SILENT), contextWith());
    const entry = result.entries.find((e) => e.id === NEVER_USED.id);
    expect(entry?.bucket).toBe("not-applicable");
    expect(entry?.note).toContain("legacy");
    expect(entry?.evidence.length).toBeGreaterThan(0);
  });

  it("should still report a legacy api the project uses", () => {
    const used: PredicateSet = {
      ...NEVER_USED,
      detectUsed: () => match(["/project/next.config.ts"]),
      noSuggestion: SILENT,
    };
    const result = classify(legacyCatalog(used), contextWith());
    expect(result.entries.find((e) => e.id === used.id)?.bucket).toBe("used");
  });

  it.each(["default", "strict"] as const)(
    "should neither suggest nor withhold a legacy api under the %s preset",
    (preset) => {
      const suggestible: PredicateSet = {
        ...NEVER_USED,
        wouldApply: () => suggest(["/project/next.config.ts"], "would match", "what it buys"),
      };
      const result = classify(legacyCatalog(suggestible), contextWith(), preset);
      expect(result.entries.find((e) => e.id === suggestible.id)?.bucket).toBe("not-applicable");
      // The entry adds nothing to the count; what is left is the channel the preset withholds.
      expect(result.withheldHeuristics).toBe(preset === "strict" ? 0 : CHANNEL_WITHHELD);
    },
  );

  // The count promises --strict reveals what it held back. A legacy entry is never suggested under
  // either preset, so an opt-in condition on one is not held back, it is moot.
  it("should not count an opt-in condition on a legacy api", () => {
    const suggestible: PredicateSet = {
      ...NEVER_USED,
      wouldApplyStrict: () => suggest(["/project/next.config.ts"], "observed", "what it buys"),
    };
    const result = classify(legacyCatalog(suggestible), contextWith(), "default");
    expect(result.entries.find((e) => e.id === suggestible.id)?.bucket).toBe("not-applicable");
    expect(result.withheldHeuristics).toBe(CHANNEL_WITHHELD);
  });

  it("should dismiss once when an authored not-applicable predicate also matches", () => {
    const alsoDismissed: PredicateSet = {
      ...NEVER_USED,
      notApplicable: () => match(["/project/app"], "an authored reason"),
      noSuggestion: SILENT,
    };
    const result = classify(legacyCatalog(alsoDismissed), contextWith());
    const matching = result.entries.filter((e) => e.id === alsoDismissed.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.note).toContain("legacy");
  });
});

describe("undeclared packages reach the entry that names them", () => {
  it("should attach the finding to the option's own entry", () => {
    const id = "config/next-config-js/serverExternalPackages";
    const used: PredicateSet = {
      id,
      cost: "FS",
      noSuggestion: SILENT,
      detectUsed: () => match(["/project/next.config.ts"]),
    };
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      undeclaredPackages: new Map([
        [id, [{ value: "@nope/missing", files: ["/project/next.config.ts"] }]],
      ]),
    };
    const result = classify(
      buildCatalog(surfaceOf([id]), [used]),
      contextWith(),
      "default",
      ledger,
    );
    const entry = result.entries.find((e) => e.id === id);
    expect(entry?.unmatched?.note).toContain("manifest declares no such dependency");
    expect(entry?.unmatched?.declarations.map((d) => d.value)).toEqual(["@nope/missing"]);
    expect(result.unmatchedDeclarations).toBe(1);
  });
});

const BUILD: BuildOutput = {
  buildId: "test-build",
  routeUrls: new Map([["/page", "/"]]),
  prerendered: new Map([["/", { url: "/", mode: "STATIC" }]]),
  dynamicRoutes: new Map(),
  unreadableEntries: 0,
  weights: NO_WEIGHTS,
  browserSourceMaps: { count: 0, bytes: 0, reason: "no build directory was read" },
};

function classifyWithBuild(predicates: readonly PredicateSet[], build: PredicateContext["build"]) {
  const catalog = buildCatalog(surfaceOf(predicates.map((predicate) => predicate.id)), predicates);
  return classify(catalog, { ...contextWith(), build });
}

/** An entry that answered with a refusal, which is the only kind a reopening may be filed on. */
const REOPENED_ID = [...REFUSED_WHEN_THE_RULE_CHANGED][0] ?? "";

const BUILD_TIER: PredicateSet = {
  id: REOPENED_ID,
  cost: "BUILD",
  noSuggestion: SILENT,
  detectUsed: (context) =>
    context.build.status === "resolved" ? match([`${ROOT}/app/page.tsx`]) : NO_MATCH,
};

/**
 * Classification without assembly, and only here.
 *
 * Assembly refuses a used detection declaring `BUILD` outright — it decides a bucket under the
 * default preset, which is the claim the release plan holds back until the build phase exists. The
 * classifier still has to know what to do with one, because that is the behaviour v4 arrives to
 * use, and the spec states it. So the catalog is built by hand to reach the branch that assembly
 * makes unreachable, and this is the only place that is true.
 */
function classifyUnassembled(
  predicates: readonly PredicateSet[],
  build: PredicateContext["build"],
) {
  const surface = surfaceOf(predicates.map((predicate) => predicate.id));
  if (surface.status !== "available") throw new Error("expected a surface");
  const entries = predicates.map((set, index) => {
    const derived = surface.entries[index];
    if (derived === undefined) throw new Error("expected a surface entry");
    return { surface: derived, predicates: set };
  });
  return classify(
    { entries, documentedNotCovered: [], documentedNotAdoptable: [], predicatesWithoutSurface: [] },
    { ...contextWith(), build },
  );
}

describe("entries whose used detection needs a build", () => {
  it("should report a BUILD-tier entry as not evaluated when there is no build", () => {
    const result = classifyUnassembled(
      [BUILD_TIER],
      unresolved("no production build found at .next"),
    );
    expect(result.entries[0]?.bucket).toBe("not-evaluated");
    expect(result.entries[0]?.needsBuild).toBe("no production build found at .next");
    expect(result.needingBuild).toBe(1);
  });

  it("should evaluate a BUILD-tier entry when a build was read", () => {
    const result = classifyUnassembled([BUILD_TIER], resolved(BUILD));
    expect(result.entries[0]?.bucket).toBe("used");
    expect(result.needingBuild).toBe(0);
  });

  it("should keep a missing build and a missing flag as separate counts", () => {
    const flagged: PredicateSet = {
      id: "file-conventions/template",
      cost: "AST",
      noSuggestion: SILENT,
      requiredFlag: "experimental.authInterrupts",
      detectUsed: () => NO_MATCH,
    };
    const result = classifyUnassembled([BUILD_TIER, flagged], unresolved("no build"));
    expect(result.needingBuild).toBe(1);
    expect(result.skippedForFlag).toBe(1);
    expect(result.notEvaluated).toBe(2);
  });
});

/**
 * The half that matters most. A condition that reads a build and has none leaves the entry
 * classifiable — it was answered from the used detection, which read something else — so the entry
 * keeps its bucket and only the suggestion is missing.
 */
describe("conditions that need a build", () => {
  const CONDITION_TIER: PredicateSet = {
    id: REOPENED_ID,
    cost: "FS",
    conditionCost: "BUILD",
    reopenedFrom: {
      condition: "a shape somebody tried",
      outcome: "and the measurement refused it",
    },
    detectUsed: () => NO_MATCH,
    wouldApply: () => suggest([`${ROOT}/app/page.tsx`], "the shape holds", "and this is the gain"),
  };

  /** The shape the three build-output entries hold: configured, so the used detection answers. */
  const CONFIGURED: PredicateSet = {
    ...CONDITION_TIER,
    detectUsed: () => match([`${ROOT}/next.config.ts`]),
  };

  it("should keep the used verdict and withhold only the condition", () => {
    const result = classifyWithBuild([CONFIGURED], unresolved("no build"));
    expect(result.entries[0]?.bucket).toBe("used");
    expect(result.entries[0]?.needsBuild).toBeUndefined();
    expect(result.needingBuild).toBe(0);
    expect(result.conditionsNeedingBuild).toBe(1);
  });

  it("should run the condition where a build was read", () => {
    const result = classifyWithBuild([CONDITION_TIER], resolved(BUILD));
    expect(result.entries[0]?.bucket).toBe("would-apply");
    expect(result.conditionsNeedingBuild).toBe(0);
  });

  /**
   * The invariant the new figure must not join. `skippedForFlag` and `needingBuild` sum with the
   * rest into `notEvaluated`; a condition withheld for a build is outside that sum, because its
   * entry was evaluated. An entry the condition was the only argument for still lands in
   * not-evaluated — nothing suggested it and nothing dismissed it — and that is the ordinary
   * silence, not the build's.
   */
  it("should keep the not-evaluated breakdown summing without it", () => {
    const result = classifyWithBuild([CONDITION_TIER], unresolved("no build"));
    expect(result.needingBuild).toBe(0);
    expect(result.skippedForFlag).toBe(0);
    expect(result.conditionsNeedingBuild).toBe(1);
    expect(result.entries[0]?.needsBuild).toBeUndefined();
  });
});

describe("a build never moves a bucket", () => {
  it("should report the same buckets with a build as without one", () => {
    const source: PredicateSet = {
      id: "file-conventions/layout",
      cost: "AST",
      noSuggestion: SILENT,
      detectUsed: () => match([`${ROOT}/app/layout.tsx`]),
    };
    const withBuild = classifyWithBuild([source], resolved(BUILD));
    const without = classifyWithBuild([source], unresolved("no build"));
    expect(withBuild.used).toBe(without.used);
    expect(withBuild.evaluated).toBe(without.evaluated);
    expect(withBuild.notApplicable).toBe(without.notApplicable);
    expect(withBuild.entries.map((entry) => entry.bucket)).toEqual(
      without.entries.map((entry) => entry.bucket),
    );
  });
});

describe("recorded weights never move a bucket", () => {
  it("should report the same buckets with the weights as without them", () => {
    const source: PredicateSet = {
      id: "file-conventions/layout",
      cost: "AST",
      noSuggestion: SILENT,
      detectUsed: () => match([`${ROOT}/app/layout.tsx`]),
    };
    const catalog = buildCatalog(surfaceOf([source.id]), [source]);
    const context = contextWith();
    const without = classify(catalog, context);
    const withWeights = classify(
      catalog,
      context,
      "default",
      EMPTY_LEDGER,
      undefined,
      undefined,
      undefined,
      {
        urlSource: "build",
        routes: [
          { url: "/a", modules: new Set(["m"]), filePathRoutes: [], entries: [] },
          { url: "/b", modules: new Set(), filePathRoutes: [], entries: [] },
        ],
      },
      { agreement: 1, orderedPairs: 1, compared: 2, withoutFigure: 0, ranked: [], furthest: [] },
    );
    expect(withWeights.used).toBe(without.used);
    expect(withWeights.evaluated).toBe(without.evaluated);
    expect(withWeights.notApplicable).toBe(without.notApplicable);
    expect(withWeights.entries.map((entry) => entry.bucket)).toEqual(
      without.entries.map((entry) => entry.bucket),
    );
  });
});

describe("the silence carries its reason", () => {
  it("should mark a condition that ran and did not hold as evaluated", () => {
    const result = classifyOne({
      id: "file-conventions/page",
      cost: "FS",
      detectUsed: () => NO_MATCH,
      wouldApply: () => NO_MATCH,
    });
    expect(result.entries[0]?.bucket).toBe("not-evaluated");
    expect(result.entries[0]?.silence).toEqual({ kind: "evaluated" });
    expect(result.silence.evaluated).toBe(1);
  });

  it("should carry an authored reason through to the entry", () => {
    const result = classifyOne({
      id: "file-conventions/page",
      cost: "FS",
      detectUsed: () => NO_MATCH,
      noSuggestion: { kind: "abstained", why: "a decision, not a gap", measuredAgainst: "16.3.0" },
    });
    expect(result.entries[0]?.silence).toEqual({
      kind: "abstained",
      why: "a decision, not a gap",
      measuredAgainst: "16.3.0",
    });
    expect(result.silence.abstained).toBe(1);
  });

  it("should count a delegated reason apart from an unwritten one", () => {
    const catalog = buildCatalog(surfaceOf(["a", "b"]), [
      {
        id: "a",
        cost: "FS",
        detectUsed: () => NO_MATCH,
        noSuggestion: { kind: "delegated", to: "b", measuredAgainst: "16.3.0" },
      },
      { id: "b", cost: "FS", detectUsed: () => NO_MATCH, noSuggestion: SILENT },
    ]);
    const result = classify(catalog, contextWith());
    expect(result.silence.delegated).toBe(1);
    expect(result.silence.unwritten).toBe(1);
  });

  it("should leave a flag-skipped entry to the reason it already had", () => {
    const result = classifyOne({
      id: "file-conventions/forbidden",
      cost: "FS",
      requiredFlag: "experimental.authInterrupts",
      detectUsed: () => NO_MATCH,
      noSuggestion: SILENT,
    });
    expect(result.entries[0]?.skippedForFlag).toBe("experimental.authInterrupts");
    expect(result.entries[0]?.silence).toBeUndefined();
  });

  it("should have the parts sum to the not-evaluated total", () => {
    const catalog = buildCatalog(surfaceOf(["a", "b", "c"]), [
      { id: "a", cost: "FS", detectUsed: () => NO_MATCH, wouldApply: () => NO_MATCH },
      {
        id: "b",
        cost: "FS",
        detectUsed: () => NO_MATCH,
        noSuggestion: { kind: "abstained", why: "why", measuredAgainst: "16.3.0" },
      },
      { id: "c", cost: "FS", detectUsed: () => NO_MATCH, noSuggestion: SILENT },
    ]);
    const result = classify(catalog, contextWith());
    const { evaluated, abstained, delegated, unwritten } = result.silence;
    expect(evaluated + abstained + delegated + unwritten).toBe(
      result.notEvaluated - result.skippedForFlag - result.needingBuild,
    );
  });
});

describe("a dismissal has to be checkable", () => {
  it("should refuse a not-applicable verdict carrying no evidence", () => {
    expect(() =>
      classifyOne({
        id: "file-conventions/page",
        cost: "FS",
        detectUsed: () => NO_MATCH,
        notApplicable: () => ({ matched: true, evidence: [] }),
        noSuggestion: SILENT,
      }),
    ).toThrow(MissingEvidenceError);
  });

  it("should let a project using the api outrank a failing prerequisite", () => {
    // A dismissal describes a question that does not arise. It cannot arise and be used at once,
    // so a project demonstrably using the API settles it.
    const result = classifyOne({
      id: "file-conventions/page",
      cost: "FS",
      detectUsed: () => match([`${ROOT}/app/page.tsx`]),
      notApplicable: () => match([`${ROOT}/app`], "a prerequisite that failed"),
      noSuggestion: SILENT,
    });
    expect(result.entries[0]?.bucket).toBe("used");
  });
});

describe("the unexamined option remainder", () => {
  /** Three option pages, none of them authored, so all three take the derived predicate. */
  const optionSurface = surfaceOf([
    "config/next-config-js/basePath",
    "config/next-config-js/assetPrefix",
    "config/next-config-js/distDir",
  ]);

  it("should count the options still carrying the derived reason", () => {
    const result = classify(buildCatalog(optionSurface, []), contextWith());
    expect(result.unexaminedOptions).toBe(3);
  });

  it("should lower the count by one when an option is authored out of the group", () => {
    const authored: PredicateSet = {
      id: "config/next-config-js/distDir",
      cost: "FS",
      detectUsed: () => NO_MATCH,
      noSuggestion: {
        kind: "examined",
        measuredAgainst: "16.3.0",
        failed: "condition",
        condition: "a source tree naming the build directory it wants",
        outcome: "nothing names one, and the option is a deployment decision",
      },
    };
    const result = classify(buildCatalog(optionSurface, [authored]), contextWith());
    expect(result.unexaminedOptions).toBe(2);
  });

  it("should count an option the project sets, which sits in used and not in the silence", () => {
    // The figure is over the catalog, not over the entries with no verdict: an option a project
    // configures is reported as used and would otherwise hide its own unexamined state there.
    const root = mkdtempSync(join(tmpdir(), "next-coverage-remainder-"));
    writeFileSync(join(root, "next.config.ts"), "export default { basePath: '/docs' };");
    const context = contextWith();
    const configured = {
      ...context,
      project: { ...context.project, config: readNextConfig(root) },
    } satisfies PredicateContext;

    const result = classify(buildCatalog(optionSurface, []), configured);
    expect(result.entries.find((e) => e.id.endsWith("basePath"))?.bucket).toBe("used");
    expect(result.silence.abstained).toBe(2);
    expect(result.unexaminedOptions).toBe(3);
  });
});

describe("which release a verdict was measured against", () => {
  /** The project context with an installed release, which the default one deliberately lacks. */
  function installedAt(version: string): PredicateContext {
    const context = contextWith();
    return {
      ...context,
      project: {
        ...context.project,
        installedNext: { realPath: ROOT, linkPath: ROOT, version },
      },
    } satisfies PredicateContext;
  }

  /** One entry per stamp, each abstaining so every one carries a verdict to count. */
  function counts(installed: string, stamps: readonly string[]) {
    const ids = stamps.map((_, index) => `entry-${index}`);
    const catalog = buildCatalog(
      surfaceOf(ids),
      ids.map((id, index) => ({
        id,
        cost: "FS" as const,
        detectUsed: () => NO_MATCH,
        noSuggestion: {
          kind: "abstained" as const,
          why: "a decision, not a gap",
          measuredAgainst: stamps[index] ?? "16.3.0",
        },
      })),
    );
    return classify(catalog, installedAt(installed));
  }

  /**
   * The defect: the comparison was `===` over the whole string, so a patch bump counted every
   * authored verdict as stale. Sixty-eight of the seventy name one release, and a project on the
   * current stable patch was told nearly all of them were measured against something older.
   */
  it("should count a patch apart from the release it was measured against as the same one", () => {
    const result = counts("16.3.1", ["16.3.0", "16.3.4"]);
    expect(result.verdictsAgainstThisRelease).toBe(2);
    expect(result.verdictsAgainstAnOlderRelease).toBe(0);
    expect(result.verdictsAgainstANewerRelease).toBe(0);
  });

  it("should count a verdict measured against an earlier minor as older", () => {
    const result = counts("16.3.1", ["16.3.0", "16.2.6"]);
    expect(result.verdictsAgainstThisRelease).toBe(1);
    expect(result.verdictsAgainstAnOlderRelease).toBe(1);
    expect(result.verdictsAgainstANewerRelease).toBe(0);
  });

  /**
   * The other half of the defect: this shape reported "measured against an older release than the
   * one installed" when the reading was made against a newer one.
   */
  it("should count a verdict measured against a later minor as newer, not older", () => {
    const result = counts("16.2.6", ["16.3.0", "16.3.0", "16.2.6"]);
    expect(result.verdictsAgainstThisRelease).toBe(1);
    expect(result.verdictsAgainstAnOlderRelease).toBe(0);
    expect(result.verdictsAgainstANewerRelease).toBe(2);
  });

  it("should order by major before minor", () => {
    const result = counts("16.3.0", ["15.9.0", "17.0.0"]);
    expect(result.verdictsAgainstAnOlderRelease).toBe(1);
    expect(result.verdictsAgainstANewerRelease).toBe(1);
  });

  /** A prerelease documents the minor it belongs to, so the tag is not what is compared. */
  it("should read a prerelease as its own minor", () => {
    const result = counts("16.3.0-preview.9", ["16.3.0"]);
    expect(result.verdictsAgainstThisRelease).toBe(1);
  });

  it("should count nothing where no release is installed", () => {
    const catalog = buildCatalog(surfaceOf(["a"]), [
      {
        id: "a",
        cost: "FS",
        detectUsed: () => NO_MATCH,
        noSuggestion: { kind: "abstained", why: "why", measuredAgainst: "16.2.0" },
      },
    ]);
    const result = classify(catalog, contextWith());
    expect(result.verdictsAgainstThisRelease).toBe(0);
    expect(result.verdictsAgainstAnOlderRelease).toBe(0);
    expect(result.verdictsAgainstANewerRelease).toBe(0);
  });

  /** The unwritten kind names no release, so it joins neither direction nor the matching count. */
  it("should count no unwritten reason in any direction", () => {
    const catalog = buildCatalog(surfaceOf(["a"]), [
      { id: "a", cost: "FS", detectUsed: () => NO_MATCH, noSuggestion: SILENT },
    ]);
    const result = classify(catalog, installedAt("16.3.1"));
    expect(result.verdictsAgainstThisRelease).toBe(0);
    expect(result.verdictsAgainstAnOlderRelease).toBe(0);
    expect(result.verdictsAgainstANewerRelease).toBe(0);
  });
});
