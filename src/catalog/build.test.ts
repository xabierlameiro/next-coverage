import { describe, expect, it } from "vitest";
import { fixtureContext } from "../../test-support/corpus.js";
import { FIXTURES, fixtureAvailable, okAnalysis } from "../../test-support/fixtures.js";
import type { SurfaceDerivation, SurfaceEntry } from "../collect/docs.js";
import {
  BorrowedReasonError,
  ConditionCostWithoutConditionError,
  DanglingDelegationError,
  DeprecatedOptionConditionError,
  DroppedRefusalError,
  DuplicatePredicateError,
  GraphTierUnderTheDefaultPresetError,
  NarrowingWithoutGraphTierError,
  PrematureBuildTierError,
  PromotedRestatementError,
  SilentPredicateError,
  UnattributedConditionCostError,
  UnexaminedRefusalError,
  UnpromotableConditionError,
  UnrecordedReopeningError,
  UsedDetectionBuildTierError,
} from "../errors.js";
import type { CostTier } from "../types.js";
/**
 * One analysis per fixture, shared across this file's assertions. The pipeline is deterministic
 * and takes seconds, so re-running it per assertion buys nothing — the same reason
 * `analysis.test.ts` caches it.
 */
import { ALL_PREDICATES, buildCatalog, citesTheCorpus } from "./build.js";
import { DERIVED_OPTION_REASON } from "./config.js";
import {
  ABSTAINED_WHEN_THE_RULE_CHANGED,
  REFUSED_WHEN_THE_RULE_CHANGED,
  UNPROMOTABLE_BY_CONSTRUCTION,
} from "./reopened.js";
import { match, NO_MATCH, type PredicateSet, suggest } from "./types.js";

/** The reason a set with no condition now has to carry. */
const SILENT = { kind: "unwritten", why: "nothing written for this test entry" } as const;

function surfaceEntry(
  id: string,
  domain: SurfaceEntry["domain"] = "file-conventions",
  adoptable = true,
): SurfaceEntry {
  return {
    id,
    domain,
    title: id,
    relatedLinks: [],
    docPath: `/docs/${id}.md`,
    frontmatterFailed: false,
    docRelativePath: "",
    docUrl: "",
    adoptable,
  };
}

function available(ids: readonly string[]): SurfaceDerivation {
  return {
    status: "available",
    referenceRoot: "/docs",
    entries: ids.map((id) => surfaceEntry(id)),
  };
}

const alwaysUsed = (id: string): PredicateSet => ({
  id,
  cost: "FS",
  noSuggestion: SILENT,
  detectUsed: () => match(["/evidence"]),
});

describe("catalog join", () => {
  it("should pair a derived entry with its authored predicate", () => {
    const catalog = buildCatalog(available(["file-conventions/page"]), [
      alwaysUsed("file-conventions/page"),
    ]);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]?.surface.id).toBe("file-conventions/page");
  });

  it("should report a documented api with no predicate as our own gap", () => {
    const catalog = buildCatalog(available(["file-conventions/page", "functions/io"]), [
      alwaysUsed("file-conventions/page"),
    ]);
    expect(catalog.documentedNotCovered.map((e) => e.id)).toEqual(["functions/io"]);
  });

  it("should keep a documented page nothing can adopt out of our own gap", () => {
    const catalog = buildCatalog(
      {
        status: "available",
        referenceRoot: "/docs",
        entries: [
          surfaceEntry("functions/io"),
          surfaceEntry("adapters/creating-an-adapter", "adapters", false),
        ],
      },
      [],
    );
    expect(catalog.documentedNotCovered.map((e) => e.id)).toEqual(["functions/io"]);
    expect(catalog.documentedNotAdoptable.map((e) => e.id)).toEqual([
      "adapters/creating-an-adapter",
    ]);
  });

  it("should join a predicate authored against a non-adoptable page", () => {
    const catalog = buildCatalog(
      {
        status: "available",
        referenceRoot: "/docs",
        entries: [surfaceEntry("adapters/creating-an-adapter", "adapters", false)],
      },
      [alwaysUsed("adapters/creating-an-adapter")],
    );
    expect(catalog.entries.map((e) => e.surface.id)).toEqual(["adapters/creating-an-adapter"]);
    expect(catalog.documentedNotAdoptable).toEqual([]);
  });

  it("should report a predicate whose api the installed version does not document", () => {
    const catalog = buildCatalog(available(["file-conventions/page"]), [
      alwaysUsed("file-conventions/page"),
      alwaysUsed("functions/io"),
    ]);
    expect(catalog.predicatesWithoutSurface).toEqual(["functions/io"]);
  });

  it("should refuse two predicates declaring the same id", () => {
    expect(() => buildCatalog(available([]), [alwaysUsed("a"), alwaysUsed("a")])).toThrow(
      DuplicatePredicateError,
    );
  });

  /**
   * The release plan holds the BUILD tier until v4 and a reopened condition is the one exception.
   * The exception is what could widen by being copied, so assembly is where it is held.
   */
  describe("the BUILD tier before v4", () => {
    const REFUSAL = {
      condition: "a shape somebody tried",
      outcome: "and the measurement refused it",
    } as const;

    const withACondition = (id: string, conditionCost: CostTier): PredicateSet => ({
      id,
      cost: "FS",
      conditionCost,
      detectUsed: () => NO_MATCH,
      wouldApplyStrict: () => NO_MATCH,
    });

    it("should refuse a BUILD condition that reopened nothing", () => {
      expect(() => buildCatalog(available([]), [withACondition("a", "BUILD")])).toThrow(
        PrematureBuildTierError,
      );
    });

    it("should accept a BUILD condition that carries the refusal it replaced", () => {
      // On an entry that answered with a refusal: a reopening is only a reopening where there was
      // one, which the assembly checks separately.
      const refused = [...REFUSED_WHEN_THE_RULE_CHANGED][0] ?? "";
      const catalog = buildCatalog(available([refused]), [
        { ...withACondition(refused, "BUILD"), reopenedFrom: REFUSAL },
      ]);
      expect(catalog.entries).toHaveLength(1);
    });

    /**
     * The half the per-predicate tier sharpened. Used detection decides a bucket and runs under the
     * default preset, so the tier the release plan holds back cannot sit there whatever else the
     * set carries — and the set-level guard let exactly that through whenever a set happened to
     * carry a reopening.
     */
    it("should refuse the tier on used detection, reopened or not", () => {
      const refused = [...REFUSED_WHEN_THE_RULE_CHANGED][0] ?? "";
      expect(() => buildCatalog(available([]), [{ ...alwaysUsed("a"), cost: "BUILD" }])).toThrow(
        UsedDetectionBuildTierError,
      );
      expect(() =>
        buildCatalog(available([refused]), [
          { ...alwaysUsed(refused), cost: "BUILD", reopenedFrom: REFUSAL },
        ]),
      ).toThrow(UsedDetectionBuildTierError);
    });

    it("should refuse a condition's tier on a set that carries no condition", () => {
      expect(() =>
        buildCatalog(available([]), [{ ...alwaysUsed("a"), conditionCost: "GRAFO" }]),
      ).toThrow(ConditionCostWithoutConditionError);
    });

    it("should leave the other tiers alone, reopened or not", () => {
      // `GRAFO` on used detection is refused now, by the guard against a graph reading under the
      // default preset rather than by anything here — so it is asserted there and left out of this
      // list, which is about the reach of the BUILD guard. As a condition it is still accepted,
      // because `withACondition` builds a strict-only one.
      for (const cost of ["FS", "AST"] as const) {
        expect(() => buildCatalog(available([]), [{ ...alwaysUsed("a"), cost }])).not.toThrow();
      }
      for (const cost of ["FS", "AST", "GRAFO"] as const) {
        expect(() => buildCatalog(available([]), [withACondition("a", cost)])).not.toThrow();
      }
    });

    /**
     * The tier arrives without the release because a project with no build hands the predicate an
     * unresolved reading, which is the state every other reader of it already handles. Asserted on
     * the context rather than on a predicate: what matters is that there is nothing to read, and a
     * condition that answered from an unresolved build would be reporting on a build it never saw.
     */
    it("should hand a predicate nothing to read where the project has no build", () => {
      // `unflagged-app` is vendored, never built and never run, which is exactly the state.
      const context = fixtureContext("unflagged-app");
      expect(context.build.status).toBe("unresolved");
    });
  });

  /**
   * A conversion replaces the refusal with a predicate, so nothing in the assembled set records
   * that there ever was one. The frozen list is what remembers, and this is what makes it bite.
   */
  describe("a refusal a conversion left behind", () => {
    const refused = [...REFUSED_WHEN_THE_RULE_CHANGED][0] ?? "";

    it("should refuse a condition on a refused entry that carries no reopening", () => {
      expect(() =>
        buildCatalog(available([]), [
          {
            id: refused,
            cost: "AST",
            detectUsed: () => NO_MATCH,
            wouldApplyStrict: () => NO_MATCH,
          },
        ]),
      ).toThrow(DroppedRefusalError);
    });

    it("should accept the same condition once it carries the refusal it replaced", () => {
      expect(() =>
        buildCatalog(available([]), [
          {
            id: refused,
            cost: "AST",
            detectUsed: () => NO_MATCH,
            wouldApplyStrict: () => NO_MATCH,
            reopenedFrom: { condition: "a shape somebody tried", outcome: "and it was refused" },
          },
        ]),
      ).not.toThrow();
    });

    it("should leave an entry that still answers with its refusal alone", () => {
      expect(() => buildCatalog(available([]), [alwaysUsed(refused)])).not.toThrow();
    });
  });

  /**
   * Two conditions whose objection names a measurement nobody here can take — the size the chunker
   * splits at, and the memory a build holds. Promotion is defined as a project's evidence
   * answering the objection, and no working tree carries either figure, so the entries are
   * registered rather than left in the queue of conditions somebody could still answer.
   */
  describe("a condition no evidence can promote", () => {
    const unpromotable = [...UNPROMOTABLE_BY_CONSTRUCTION][0] ?? "";

    it("should refuse a default-preset condition on a registered entry", () => {
      expect(() =>
        buildCatalog(available([]), [
          {
            id: unpromotable,
            cost: "FS",
            detectUsed: () => NO_MATCH,
            wouldApply: () => NO_MATCH,
            reopenedFrom: { condition: "a shape somebody tried", outcome: "and it was refused" },
          },
        ]),
      ).toThrow(UnpromotableConditionError);
    });

    it("should leave the same entry alone behind the strict preset", () => {
      expect(() =>
        buildCatalog(available([]), [
          {
            id: unpromotable,
            cost: "FS",
            detectUsed: () => NO_MATCH,
            wouldApplyStrict: () => NO_MATCH,
            reopenedFrom: { condition: "a shape somebody tried", outcome: "and it was refused" },
          },
        ]),
      ).not.toThrow();
    });

    it("should refuse a reopening on an entry that answered with no refusal", () => {
      expect(() =>
        buildCatalog(available([]), [
          {
            ...alwaysUsed("file-conventions/page"),
            reopenedFrom: { condition: "a shape nobody tried", outcome: "and nobody refused it" },
          },
        ]),
      ).toThrow(UnrecordedReopeningError);
    });

    it("should register both entries the family names", () => {
      expect([...UNPROMOTABLE_BY_CONSTRUCTION].sort()).toEqual([
        "config/next-config-js/turbopackChunking",
        "config/next-config-js/turbopackMemoryEviction",
      ]);
    });

    it("should say nothing about an entry nobody refused", () => {
      expect(() =>
        buildCatalog(available([]), [
          {
            id: "file-conventions/page",
            cost: "AST",
            detectUsed: () => NO_MATCH,
            wouldApplyStrict: () => NO_MATCH,
          },
        ]),
      ).not.toThrow();
    });
  });

  it("should produce no entries when the surface is unavailable", () => {
    const catalog = buildCatalog({ status: "unavailable", reason: "no docs" }, [alwaysUsed("a")]);
    expect(catalog.entries).toEqual([]);
    expect(catalog.predicatesWithoutSurface).toEqual(["a"]);
  });

  it("should sort entries by domain then id", () => {
    const surface: SurfaceDerivation = {
      status: "available",
      referenceRoot: "/docs",
      entries: [surfaceEntry("functions/b", "functions"), surfaceEntry("file-conventions/a")],
    };
    const catalog = buildCatalog(surface, [
      alwaysUsed("functions/b"),
      alwaysUsed("file-conventions/a"),
    ]);
    expect(catalog.entries.map((e) => e.surface.id)).toEqual(["file-conventions/a", "functions/b"]);
  });
});

describe("authored predicates", () => {
  it("should declare unique ids across the whole catalog", () => {
    const ids = ALL_PREDICATES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("should declare a cost tier on every predicate set", () => {
    for (const predicate of ALL_PREDICATES) {
      expect(["FS", "AST", "GRAFO", "BUILD"]).toContain(predicate.cost);
    }
  });

  // `FS`, `AST` and `GRAFO` are all readable from the filesystem and the sources. `BUILD` is held
  // back by the release plan until v4, with one exception: a reopened condition may declare it,
  // because it is strict-only and reads nothing on a project with no build. Assembly enforces that;
  // this asserts the shipped catalog against it, so a predicate that acquires the tier without a
  // refusal to reopen fails here as well as there.
  it("should ship no tier that needs a build unless it reopened a refusal", () => {
    const build = ALL_PREDICATES.filter((p) => p.cost === "BUILD");
    expect(build.filter((p) => p.reopenedFrom === undefined)).toEqual([]);
  });

  // The six sets whose condition reads the module graph. `cost` states what their used detection
  // reads and nothing else, because it is what every run pays: `usesConvention` reads route-tree
  // conventions built from file names, and `importedFrom` matches one file's imports. The graph is
  // read by their conditions, and `conditionCost` is where that is said.
  it("should declare the graph on the condition that reads it, not on the used detection", () => {
    const readsTheGraph = [
      "file-conventions/not-found",
      "functions/catchError",
      "functions/next-root-params",
      "functions/unstable_rethrow",
      "functions/use-params",
      "functions/use-selected-layout-segment",
    ];
    const byId = new Map(ALL_PREDICATES.map((p) => [p.id, p]));
    for (const id of readsTheGraph) {
      expect(byId.get(id)?.conditionCost, id).toBe("GRAFO");
    }
    expect(byId.get("file-conventions/not-found")?.cost).toBe("FS");
    for (const id of readsTheGraph.filter((each) => each.startsWith("functions/"))) {
      expect(byId.get(id)?.cost, id).toBe("AST");
    }
    // No used detection claims the graph: the set's own tier is the floor a default run pays.
    expect(ALL_PREDICATES.filter((p) => p.cost === "GRAFO").map((p) => p.id)).toEqual([]);
  });

  // The same slip one tier down. Both look up a convention in the route tree, which is `FS`; their
  // conditions read the scanned sources, which is what `AST` describes. `template` used to carry
  // the reason in a comment — "AST rather than FS: the second condition reads a layout's
  // directives and calls" — which is a condition's reading given as the entry's tier.
  it("should declare a condition's source reading apart from a convention lookup", () => {
    const byId = new Map(ALL_PREDICATES.map((p) => [p.id, p]));
    for (const id of ["file-conventions/loading", "file-conventions/template"]) {
      expect(byId.get(id)?.cost, id).toBe("FS");
      expect(byId.get(id)?.conditionCost, id).toBe("AST");
      // Their two conditions read the same thing, and an absent attribution is what says so.
      expect(byId.get(id)?.conditionCostReadBy, id).toBeUndefined();
    }
  });

  // `not-found` is the only set carrying two conditions that read different things, so its tier
  // has to say which one performs the reading. Naming the default-preset condition would make
  // anything policing what a default run may read refuse the entry for a reading that condition
  // never makes — `uncaughtNotFoundCalls` does not touch the graph.
  it("should attribute a two-condition tier to the condition that reads it", () => {
    const notFound = ALL_PREDICATES.find((p) => p.id === "file-conventions/not-found");
    expect(notFound?.conditionCostReadBy).toBe("strict");
    expect(notFound?.wouldApply).toBeDefined();
    expect(notFound?.wouldApplyStrict).toBeDefined();
    // Nobody else claims the attribution, so every other tier speaks for one condition.
    expect(
      ALL_PREDICATES.filter(
        (p) => p.conditionCostReadBy !== undefined && p.id !== "file-conventions/not-found",
      ).map((p) => p.id),
    ).toEqual([]);
  });

  /**
   * The rule is stated of the preset, not of the tier: a graph reading does not run under the
   * default preset. Every branch below follows from that one sentence, and each is built from a
   * constructed set so the branch is proven by its shape rather than by a catalog entry that
   * happens to have it.
   */
  describe("a graph reading under the default preset", () => {
    const strictOnly = (id: string): PredicateSet => ({
      id,
      cost: "FS",
      conditionCost: "GRAFO",
      detectUsed: () => NO_MATCH,
      wouldApplyStrict: () => NO_MATCH,
    });

    const bothConditions = (readBy: "default" | "strict"): PredicateSet => ({
      id: "a",
      cost: "FS",
      conditionCost: "GRAFO",
      conditionCostReadBy: readBy,
      detectUsed: () => NO_MATCH,
      wouldApply: () => NO_MATCH,
      wouldApplyStrict: () => NO_MATCH,
    });

    it("should refuse a used detection that claims the graph", () => {
      expect(() => buildCatalog(available([]), [{ ...alwaysUsed("a"), cost: "GRAFO" }])).toThrow(
        GraphTierUnderTheDefaultPresetError,
      );
    });

    it("should refuse a graph condition the default preset asks for", () => {
      const set: PredicateSet = {
        id: "a",
        cost: "FS",
        conditionCost: "GRAFO",
        detectUsed: () => NO_MATCH,
        wouldApply: () => NO_MATCH,
      };
      expect(() => buildCatalog(available([]), [set])).toThrow(GraphTierUnderTheDefaultPresetError);
    });

    // Accepted on the preset alone. A reopening is what the BUILD guard excepts, and this one takes
    // no such exception, so a set that reopened nothing has to pass for the rule to be the rule.
    it("should accept a graph condition only the strict preset asks for", () => {
      expect(() => buildCatalog(available([]), [strictOnly("a")])).not.toThrow();
    });

    it("should accept a graph reading attributed to the strict condition", () => {
      expect(() => buildCatalog(available([]), [bothConditions("strict")])).not.toThrow();
    });

    // The mirror, and the reason the attribution is load-bearing rather than documentation: without
    // this the guard could ignore `conditionCostReadBy` and every other test would still pass.
    it("should refuse the same set when the attribution names the default condition", () => {
      expect(() => buildCatalog(available([]), [bothConditions("default")])).toThrow(
        GraphTierUnderTheDefaultPresetError,
      );
    });

    it("should accept a default-preset graph reading that only narrows", () => {
      const set: PredicateSet = {
        id: "a",
        cost: "AST",
        conditionCost: "GRAFO",
        conditionCostNarrows: true,
        detectUsed: () => NO_MATCH,
        wouldApply: () => NO_MATCH,
      };
      expect(() => buildCatalog(available([]), [set])).not.toThrow();
    });

    it("should refuse the narrowing mark on a set that declares no graph reading", () => {
      const set: PredicateSet = {
        id: "a",
        cost: "AST",
        conditionCostNarrows: true,
        detectUsed: () => NO_MATCH,
        wouldApply: () => NO_MATCH,
      };
      expect(() => buildCatalog(available([]), [set])).toThrow(NarrowingWithoutGraphTierError);
    });

    it("should accept the shipped catalog, not-found included", () => {
      expect(() => buildCatalog(available([]), ALL_PREDICATES)).not.toThrow();
      const notFound = ALL_PREDICATES.find((p) => p.id === "file-conventions/not-found");
      expect(notFound?.conditionCost).toBe("GRAFO");
      expect(notFound?.wouldApply).toBeDefined();
      expect(notFound?.conditionCostReadBy).toBe("strict");
    });
  });

  it("should refuse an attribution with no tier to attribute", () => {
    const set: PredicateSet = {
      id: "a",
      cost: "FS",
      conditionCostReadBy: "strict",
      detectUsed: () => NO_MATCH,
      wouldApplyStrict: () => NO_MATCH,
    };
    expect(() => buildCatalog(available([]), [set])).toThrow(UnattributedConditionCostError);
  });

  it("should refuse an attribution on a set carrying one condition", () => {
    const set: PredicateSet = {
      id: "a",
      cost: "FS",
      conditionCost: "GRAFO",
      conditionCostReadBy: "strict",
      detectUsed: () => NO_MATCH,
      wouldApplyStrict: () => NO_MATCH,
    };
    expect(() => buildCatalog(available([]), [set])).toThrow(UnattributedConditionCostError);
  });

  // `wouldApplyPreset` withholds the whole set, so pairing it with a condition whose only purpose
  // is to be withheld on its own says two different things about the same entry.
  it("should not mark a set opt-in as a whole and per condition at once", () => {
    const incoherent = (p: PredicateSet) =>
      p.wouldApplyStrict !== undefined && p.wouldApplyPreset === "strict";
    expect(
      incoherent({
        id: "x",
        cost: "AST",
        detectUsed: () => NO_MATCH,
        wouldApply: () => NO_MATCH,
        wouldApplyPreset: "strict",
        wouldApplyStrict: () => NO_MATCH,
      }),
    ).toBe(true);
    expect(ALL_PREDICATES.filter(incoherent).map((p) => p.id)).toEqual([]);
  });

  it("should return a non-match without evidence rather than an empty match", () => {
    expect(NO_MATCH.matched).toBe(false);
    expect(NO_MATCH.evidence).toEqual([]);
  });
});

describe("derived predicates", () => {
  it("should cover a route segment config page with no authored predicate", () => {
    const id = "file-conventions/route-segment-config/runtime";
    const catalog = buildCatalog(available([id, "functions/io"]), []);
    expect(catalog.entries.map((e) => e.surface.id)).toEqual([id]);
    expect(catalog.documentedNotCovered.map((e) => e.id)).toEqual(["functions/io"]);
  });

  it("should let an authored predicate override the derived one", () => {
    const id = "file-conventions/route-segment-config/runtime";
    const catalog = buildCatalog(available([id]), [alwaysUsed(id)]);
    expect(catalog.entries[0]?.predicates.cost).toBe("FS");
  });
});

describe.skipIf(!FIXTURES.every(fixtureAvailable))("configured options in the fixtures", () => {
  it.each(FIXTURES)("should leave no adoptable page uncovered on $name", (fixture) => {
    expect(okAnalysis(fixture).result.documentedNotCovered).toBe(0);
  });
});

describe("an entry that never suggests says why", () => {
  // The type already refuses this. The cast is the point: it stands in for the one that reaches
  // assembly through a `PredicateSet[]` built somewhere the compiler was not looking.
  const withoutReason = (id: string): PredicateSet =>
    ({ id, cost: "FS", detectUsed: () => NO_MATCH }) as unknown as PredicateSet;

  it("should refuse a predicate set carrying neither a condition nor a reason", () => {
    expect(() =>
      buildCatalog(available(["file-conventions/page"]), [withoutReason("file-conventions/page")]),
    ).toThrow(SilentPredicateError);
  });

  it("should name the entry it refused, so the failure points at one predicate", () => {
    expect(() =>
      buildCatalog(available(["file-conventions/page"]), [withoutReason("file-conventions/page")]),
    ).toThrow(/file-conventions\/page/);
  });

  it("should accept a set carrying a condition instead of a reason", () => {
    const catalog = buildCatalog(available(["file-conventions/page"]), [
      {
        id: "file-conventions/page",
        cost: "FS",
        detectUsed: () => NO_MATCH,
        wouldApply: () => suggest(["/evidence"], "because", "what it buys"),
      },
    ]);
    expect(catalog.entries).toHaveLength(1);
  });

  it("should resolve a delegated suggestion against the derived surface", () => {
    const catalog = buildCatalog(
      available(["file-conventions/middleware", "file-conventions/proxy"]),
      [
        {
          id: "file-conventions/middleware",
          cost: "FS",
          detectUsed: () => NO_MATCH,
          noSuggestion: {
            kind: "delegated",
            to: "file-conventions/proxy",
            measuredAgainst: "16.3.0",
          },
        },
        alwaysUsed("file-conventions/proxy"),
      ],
    );
    expect(catalog.entries).toHaveLength(2);
  });

  it("should refuse a delegation this version does not document", () => {
    expect(() =>
      buildCatalog(available(["file-conventions/middleware"]), [
        {
          id: "file-conventions/middleware",
          cost: "FS",
          detectUsed: () => NO_MATCH,
          noSuggestion: {
            kind: "delegated",
            to: "file-conventions/proxy",
            measuredAgainst: "16.3.0",
          },
        },
      ]),
    ).toThrow(DanglingDelegationError);
  });
});

describe("every authored predicate explains itself", () => {
  it("should carry a condition or a reason on all of them", () => {
    const unexplained = ALL_PREDICATES.filter(
      (predicate) =>
        predicate.wouldApply === undefined &&
        predicate.wouldApplyStrict === undefined &&
        predicate.noSuggestion === undefined,
    );
    expect(unexplained).toEqual([]);
  });
});

describe("a reason has to be about the entry that reports it", () => {
  const OPTION_ID = "config/next-config-js/basePath";
  const optionSurface = (): SurfaceDerivation => ({
    status: "available",
    referenceRoot: "/docs",
    entries: [surfaceEntry(OPTION_ID, "config")],
  });

  it("should refuse an authored entry reusing the derived group's reason", () => {
    // The type system requires a reason and cannot require that it be about the entry. This is
    // that guard: an authored page borrowing the group's sentence reports a non-examination
    // about a page it did examine.
    const borrowed: PredicateSet = {
      id: OPTION_ID,
      cost: "FS",
      detectUsed: () => NO_MATCH,
      noSuggestion: { kind: "abstained", why: DERIVED_OPTION_REASON, measuredAgainst: "16.3.0" },
    };
    expect(() => buildCatalog(optionSurface(), [borrowed])).toThrow(BorrowedReasonError);
  });

  it.each([
    [
      "condition",
      {
        kind: "examined",
        measuredAgainst: "16.3.0",
        failed: "condition",
        condition: DERIVED_OPTION_REASON,
        outcome: "measured",
      },
    ],
    [
      "outcome",
      {
        kind: "examined",
        measuredAgainst: "16.3.0",
        failed: "condition",
        condition: "a condition",
        outcome: DERIVED_OPTION_REASON,
      },
    ],
  ] as const)(
    "should refuse an examined entry borrowing the reason in its %s",
    (_field, silence) => {
      // The refusal shape changed from one sentence to two fields, and the guard did not follow it:
      // an entry could copy the group's sentence into either field and report, in the required
      // shape, the same non-examination the contract exists to refuse.
      const borrowed: PredicateSet = {
        id: OPTION_ID,
        cost: "FS",
        detectUsed: () => NO_MATCH,
        noSuggestion: silence,
      };
      expect(() => buildCatalog(optionSurface(), [borrowed])).toThrow(BorrowedReasonError);
    },
  );

  it("should refuse a reason that carries the borrowed sentence inside a longer one", () => {
    const padded: PredicateSet = {
      id: OPTION_ID,
      cost: "FS",
      detectUsed: () => NO_MATCH,
      noSuggestion: {
        kind: "examined",
        measuredAgainst: "16.3.0",
        failed: "condition",
        condition: "a base path nothing asks for",
        outcome: `in truth, ${DERIVED_OPTION_REASON}, so nothing was tried`,
      },
    };
    expect(() => buildCatalog(optionSurface(), [padded])).toThrow(BorrowedReasonError);
  });

  it("should accept an authored entry recording what it examined", () => {
    const authored: PredicateSet = {
      id: OPTION_ID,
      cost: "FS",
      detectUsed: () => NO_MATCH,
      noSuggestion: {
        kind: "examined",
        measuredAgainst: "16.3.0",
        failed: "condition",
        condition: "a source tree naming a path prefix the configuration does not set",
        outcome: "nothing in a codebase asks for a prefix",
      },
    };
    expect(() => buildCatalog(optionSurface(), [authored])).not.toThrow();
  });

  it("should refuse an authored option that abstains without recording an examination", () => {
    // Free prose is the shape that lets a reason restating the option's purpose pass as one
    // recording a measurement. An authored option has been examined, so it has to say so.
    const prose: PredicateSet = {
      id: OPTION_ID,
      cost: "FS",
      detectUsed: () => NO_MATCH,
      noSuggestion: {
        kind: "abstained",
        why: "a base path is a deployment decision",
        measuredAgainst: "16.3.0",
      },
    };
    expect(() => buildCatalog(optionSurface(), [prose])).toThrow(UnexaminedRefusalError);
  });

  it("should leave an entry outside the option pages free to abstain in prose", () => {
    const elsewhere: PredicateSet = {
      id: "config/eslint",
      cost: "FS",
      detectUsed: () => NO_MATCH,
      noSuggestion: {
        kind: "abstained",
        why: "configuring it is a product decision",
        measuredAgainst: "16.3.0",
      },
    };
    const surface: SurfaceDerivation = {
      status: "available",
      referenceRoot: "/docs",
      entries: [surfaceEntry("config/eslint", "config")],
    };
    expect(() => buildCatalog(surface, [elsewhere])).not.toThrow();
  });

  it("should leave the derived group itself carrying that reason", () => {
    // The guard is about authored entries only. The group's own predicate must keep it.
    const catalog = buildCatalog(optionSurface(), []);
    const entry = catalog.entries.find((e) => e.surface.id === OPTION_ID);
    expect(entry?.predicates.noSuggestion).toMatchObject({
      kind: "abstained",
      why: DERIVED_OPTION_REASON,
    });
  });
});

/**
 * The survey's answer, held as data. An examined outcome fails in one of two ways and they are not
 * the same answer: a condition that held in every project argued nothing wherever it is measured,
 * and stays; a condition that held in no project found no project, which is the corpus's silence
 * written in the entry's slot. Listing the second rather than counting it keeps the survey
 * readable — a count says how much is left and an id says which entry is left.
 *
 * Four entries read `corpus` when the field was added, and all four were re-argued rather than
 * converted: each turned out to have an argument from the option's own page or from what the
 * framework already does, standing behind the measurement that had been written in its place.
 * Catalog assembly refuses the value now, so the list stays empty by more than convention.
 */
const EXAMINED_ON_THE_CORPUS: readonly string[] = [];

/**
 * The reasons still written in the corpus's voice, held as a shrinking list. The assembly check
 * that refuses them is behind a switch until the last one converts, and a switch says only that
 * something is left; this says which, so the tranche can be worked in any order and the remainder
 * is readable at every point in it.
 *
 * It reaches `[]` and the switch is removed with it.
 */
/**
 * The reasons still written in the corpus's voice. It started at twenty-four and reached `[]`,
 * which is what let the assembly check come out from behind its switch.
 *
 * Kept as a list rather than deleted with the switch: the check names one entry at a time, and
 * this names the whole set, so a reason written in that voice again is refused by the first and
 * counted by the second.
 */
const STILL_IN_THE_CORPUS_VOICE: readonly string[] = [];

/** The projects this checkout references, which a reason must not name any more than the corpus. */
const REFERENCED_NAMES = FIXTURES.map((fixture) => fixture.name);

describe("the reasons left to re-argue", () => {
  it("should be exactly the ones recorded as left, counting the referenced projects' names", () => {
    const citing = ALL_PREDICATES.filter(
      (predicate) => citesTheCorpus(predicate.noSuggestion, REFERENCED_NAMES) !== undefined,
    )
      .map((predicate) => predicate.id)
      .sort();
    expect(citing).toEqual([...STILL_IN_THE_CORPUS_VOICE].sort());
  });

  it("should catch a reason naming a referenced project only when told its name", () => {
    const silence = {
      kind: "abstained",
      why: "odd-jobs-by-timonwa never redirects",
      measuredAgainst: "16.3.0",
    } as const;
    expect(citesTheCorpus(silence)).toBeUndefined();
    expect(citesTheCorpus(silence, ["odd-jobs-by-timonwa"])).toBe("odd-jobs-by-timonwa");
    expect(citesTheCorpus(silence, ["odd-jobs"])).toBeUndefined();
  });
});

describe("an examined outcome names which of the two failed", () => {
  const examined = ALL_PREDICATES.flatMap((predicate) =>
    predicate.noSuggestion?.kind === "examined"
      ? [{ id: predicate.id, failed: predicate.noSuggestion.failed }]
      : [],
  );

  it("should have something to survey", () => {
    expect(examined.length).toBeGreaterThan(0);
  });

  it("should name the entries whose condition found no project", () => {
    const onTheCorpus = examined
      .filter((entry) => entry.failed === "corpus")
      .map((entry) => entry.id)
      .sort();
    expect(onTheCorpus).toEqual([...EXAMINED_ON_THE_CORPUS].sort());
  });
});

/**
 * The second register. A refusal says a condition was tried and came back empty; an abstention says
 * the question is not one a codebase answers. Both can be reopened and neither may be reopened with
 * the other's paperwork, which is what these hold.
 */
describe("a condition replacing an abstention", () => {
  const abstained = [...ABSTAINED_WHEN_THE_RULE_CHANGED][0] ?? "";
  const carrier = { from: abstained, why: "the question is not about code" };

  it("should refuse one that drops the abstention it replaced", () => {
    expect(() =>
      buildCatalog(available([]), [
        {
          id: abstained,
          cost: "AST",
          detectUsed: () => NO_MATCH,
          wouldApplyStrict: () => NO_MATCH,
        },
      ]),
    ).toThrow(DroppedRefusalError);
  });

  it("should accept the same condition once it carries it", () => {
    expect(() =>
      buildCatalog(available([]), [
        {
          id: abstained,
          cost: "AST",
          detectUsed: () => NO_MATCH,
          wouldApplyStrict: () => NO_MATCH,
          reopenedFrom: carrier,
        },
      ]),
    ).not.toThrow();
  });

  it("should refuse an abstention carrier on an entry that never abstained", () => {
    expect(() =>
      buildCatalog(available([]), [
        {
          ...alwaysUsed("file-conventions/page"),
          reopenedFrom: { from: "file-conventions/page", why: "nobody wrote this down" },
        },
      ]),
    ).toThrow(UnrecordedReopeningError);
  });

  /**
   * An abstention travels by reference, so a reference to somebody else's is an entry arguing from
   * an objection written about a different API — the failure the by-reference carrier would
   * otherwise make easy.
   */
  it("should refuse a carrier pointing at another entry's abstention", () => {
    const other = [...ABSTAINED_WHEN_THE_RULE_CHANGED][1] ?? "";
    expect(() =>
      buildCatalog(available([]), [
        {
          id: abstained,
          cost: "AST",
          detectUsed: () => NO_MATCH,
          wouldApplyStrict: () => NO_MATCH,
          reopenedFrom: { from: other, why: "an objection about something else" },
        },
      ]),
    ).toThrow(UnrecordedReopeningError);
  });

  it("should refuse a refusal's carrier on an entry that abstained", () => {
    expect(() =>
      buildCatalog(available([]), [
        {
          id: abstained,
          cost: "AST",
          detectUsed: () => NO_MATCH,
          wouldApplyStrict: () => NO_MATCH,
          reopenedFrom: { condition: "a shape somebody tried", outcome: "and it was refused" },
        },
      ]),
    ).toThrow(UnrecordedReopeningError);
  });

  it("should leave an entry that still answers with its abstention alone", () => {
    expect(() => buildCatalog(available([]), [alwaysUsed(abstained)])).not.toThrow();
  });

  it("should register the thirty-one ids the family reopens, and no config id", () => {
    expect(ABSTAINED_WHEN_THE_RULE_CHANGED.size).toBe(31);
    const overlap = [...ABSTAINED_WHEN_THE_RULE_CHANGED].filter((id) =>
      REFUSED_WHEN_THE_RULE_CHANGED.has(id),
    );
    expect(overlap).toEqual([]);
  });
});

/**
 * Two rules in assembly. Both are about a condition that
 * should never have been written, caught where it is written rather than in review.
 */
describe("a condition that argues the wrong way", () => {
  it("should refuse a marked restatement offered in the default preset", () => {
    expect(() =>
      buildCatalog(available([]), [
        {
          id: [...ABSTAINED_WHEN_THE_RULE_CHANGED][0] ?? "",
          cost: "AST",
          detectUsed: () => NO_MATCH,
          wouldApply: () => NO_MATCH,
          restatesUsed: true,
          reopenedFrom: {
            from: [...ABSTAINED_WHEN_THE_RULE_CHANGED][0] ?? "",
            why: "the question is not about code",
          },
        },
      ]),
    ).toThrow(PromotedRestatementError);
  });

  it("should accept the same mark behind the strict preset", () => {
    const abstained = [...ABSTAINED_WHEN_THE_RULE_CHANGED][0] ?? "";
    expect(() =>
      buildCatalog(available([]), [
        {
          id: abstained,
          cost: "AST",
          detectUsed: () => NO_MATCH,
          wouldApplyStrict: () => NO_MATCH,
          restatesUsed: true,
          reopenedFrom: { from: abstained, why: "the question is not about code" },
        },
      ]),
    ).not.toThrow();
  });

  /**
   * Read for one purpose, which moves nothing between buckets: refusing to suggest an API the
   * reference is steering readers away from. Teaching the dismissal to read it is another change.
   */
  it("should refuse a condition on a page whose title marks it deprecated", () => {
    const deprecated: SurfaceEntry = {
      ...surfaceEntry("file-conventions/route-segment-config/preferredRegion"),
      title: "preferredRegion (deprecated)",
    };
    expect(() =>
      buildCatalog({ status: "available", referenceRoot: "/docs", entries: [deprecated] }, [
        {
          id: deprecated.id,
          cost: "AST",
          detectUsed: () => NO_MATCH,
          wouldApplyStrict: () => NO_MATCH,
        },
      ]),
    ).toThrow(DeprecatedOptionConditionError);
  });

  it("should leave the same page alone while it only detects", () => {
    const deprecated: SurfaceEntry = {
      ...surfaceEntry("file-conventions/route-segment-config/preferredRegion"),
      title: "preferredRegion (deprecated)",
    };
    expect(() =>
      buildCatalog({ status: "available", referenceRoot: "/docs", entries: [deprecated] }, [
        {
          id: deprecated.id,
          cost: "AST",
          detectUsed: () => NO_MATCH,
          noSuggestion: {
            kind: "abstained",
            why: "where a route should run is a deployment decision",
            measuredAgainst: "16.3.0",
          },
        },
      ]),
    ).not.toThrow();
  });
});
