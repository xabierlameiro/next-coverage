import { describe, expect, it } from "vitest";
import { fixtureContext, projectContext, VENDORED } from "../../test-support/corpus.js";
import { FIXTURES, fixtureAvailable, once } from "../../test-support/fixtures.js";
import type { SurfaceEntry } from "../collect/docs.js";
import type { ModuleGraph } from "../collect/graph.js";
import { ALL_PREDICATES } from "./build.js";
import type { PredicateContext, PredicateSet, Suggestion } from "./types.js";
import { suggest } from "./types.js";

/**
 * Whether a condition reads the module graph is measured here rather than taken from what its set
 * declares.
 *
 * The guard in `build.ts` reads the declared tier, and a tier nobody measured is how three
 * default-preset conditions came to read the graph declaring none: the guard, when it was added,
 * counted "no set violates the rule" from the declarations. So every condition runs against every
 * fixture with a graph that records being read.
 *
 * Coverage is what the fixtures exercise: a condition that returns before reaching the graph on
 * every one of them is not caught. The vendored projects run on a fresh clone; the referenced ones
 * add their coverage where they are present.
 */

type Named = { readonly name: string; readonly context: PredicateContext };

function contexts(): readonly Named[] {
  return [
    ...VENDORED.map((name) => ({ name, context: fixtureContext(name) })),
    ...FIXTURES.filter(fixtureAvailable).map((fixture) => ({
      name: fixture.name,
      context: once(`${fixture.name}-predicate-context`, () => projectContext(fixture.path)),
    })),
  ];
}

/** Conditions read the entry for its id and title at most; the rest of the page is never asked. */
function surfaceOf(id: string): SurfaceEntry {
  return {
    id,
    domain: id.split("/")[0] as SurfaceEntry["domain"],
    title: id.slice(id.lastIndexOf("/") + 1),
    relatedLinks: [],
    docPath: "",
    frontmatterFailed: false,
    docRelativePath: "",
    docUrl: "",
    adoptable: true,
  };
}

type Condition = (context: PredicateContext, surface: SurfaceEntry) => Suggestion;

function conditionsOf(set: PredicateSet): readonly Condition[] {
  return [set.wouldApply, set.wouldApplyStrict].filter(
    (condition): condition is Condition => condition !== undefined,
  );
}

/** The context with a graph that notes whether anything asked it for a field. */
function recording(context: PredicateContext): {
  context: PredicateContext;
  wasRead: () => boolean;
} {
  let read = false;
  const graph = new Proxy(context.graph, {
    get(target, property, receiver) {
      read = true;
      return Reflect.get(target, property, receiver);
    },
  });
  return { context: { ...context, graph }, wasRead: () => read };
}

/**
 * A graph that removes nothing: every file reaches every other and none is on the client side. A
 * condition that only narrows cites, against it, exactly what one read of each file selected.
 */
function removingNothing(context: PredicateContext): ModuleGraph {
  const files = context.sources.files.map((file) => file.path);
  return {
    edges: new Map(files.map((file) => [file, files])),
    clientDeclared: new Set(),
    serverDeclared: new Set(),
    clientClosure: new Set(),
    reachedFrom: new Map(),
    clientEntries: new Set(),
    exclusiveReach: new Map(),
    unscannedEdges: 0,
  };
}

/** What a condition cites with the real graph that it would not cite with one removing nothing. */
function addedByTheGraph(condition: Condition, context: PredicateContext, id: string): string[] {
  const surface = surfaceOf(id);
  const open = new Set(
    condition({ ...context, graph: removingNothing(context) }, surface).evidence,
  );
  return condition(context, surface).evidence.filter((cited) => !open.has(cited));
}

describe("which predicates read the module graph", () => {
  it("should find no used detection reading it", () => {
    const reading = new Set<string>();
    for (const { context } of contexts()) {
      for (const set of ALL_PREDICATES) {
        const probe = recording(context);
        set.detectUsed(probe.context, surfaceOf(set.id));
        if (probe.wasRead()) reading.add(set.id);
      }
    }
    expect([...reading].sort()).toEqual([]);
  });

  it("should find every condition that reads it declaring the graph tier", () => {
    const undeclared = new Set<string>();
    for (const { context } of contexts()) {
      for (const set of ALL_PREDICATES) {
        for (const condition of conditionsOf(set)) {
          const probe = recording(context);
          condition(probe.context, surfaceOf(set.id));
          if (probe.wasRead() && set.conditionCost !== "GRAFO") undeclared.add(set.id);
        }
      }
    }
    expect([...undeclared].sort()).toEqual([]);
  });
});

/**
 * The mark that lets a graph reading run under the default preset, held to what it claims. A
 * condition marked as only narrowing must cite nothing with the real graph that it would not cite
 * with a graph removing nothing — otherwise the graph selected a file, and the finding rests on it.
 */
describe("a graph reading that only narrows", () => {
  it("should cite nothing a graph removing nothing would not", () => {
    const added: string[] = [];
    for (const { name, context } of contexts()) {
      for (const set of ALL_PREDICATES.filter((candidate) => candidate.conditionCostNarrows)) {
        for (const condition of conditionsOf(set)) {
          for (const cited of addedByTheGraph(condition, context, set.id)) {
            added.push(`${set.id} on ${name}: ${cited}`);
          }
        }
      }
    }
    expect(added).toEqual([]);
  });

  // The check above passing is only worth something if it fails for a condition the graph selects
  // for. This one cites the client side of the boundary, which a graph removing nothing leaves empty.
  it("should catch a condition that selects by the graph", () => {
    const selecting: Condition = (context) =>
      suggest([...context.graph.clientClosure].sort(), "the client side", "nothing");
    const context = fixtureContext("overconfigured-app");
    expect(addedByTheGraph(selecting, context, "functions/fetch").length).toBeGreaterThan(0);
  });

  it("should be carried by every default-preset condition that reads the graph", () => {
    const unmarked = ALL_PREDICATES.filter(
      (set) =>
        set.conditionCost === "GRAFO" &&
        set.wouldApply !== undefined &&
        set.wouldApplyPreset !== "strict" &&
        set.conditionCostReadBy !== "strict" &&
        set.conditionCostNarrows !== true,
    ).map((set) => set.id);
    expect(unmarked).toEqual([]);
  });
});
