import { showsNoReason } from "./client-reasons.js";
import {
  chainTo,
  type ModuleGraph,
  reachedWithoutDeclaring,
  rendersAnImportedClientComponent,
} from "./graph.js";
import type { SourceIndex } from "./sources.js";

/**
 * Modules that only exist on the server. `server-only` is the declared barrier; the framework's
 * request and cache modules are the ones a client bundle cannot contain either.
 */
const SERVER_MODULES = new Set(["server-only", "next/headers", "next/cache"]);

/** A module on the client side of the boundary that reaches for something only the server has. */
export type BoundaryLeak = {
  readonly module: string;
  readonly specifier: string;
  /** From the file declaring the client directive down to the module itself. */
  readonly chain: readonly string[];
};

/**
 * A client entry declaring the directive while showing none of the reasons the documentation gives
 * for it. What it carries is stated as a count of modules the graph already walks: the modules that
 * reach the client through this file and no other entry.
 */
export type DirectiveWithoutReason = {
  readonly module: string;
  readonly exclusiveModules: number;
};

export type BoundaryReport = {
  readonly leaks: readonly BoundaryLeak[];
  /**
   * Absent unless the caller asked for the examination, which is what tells a reader with no
   * findings apart from a reader who asked for none. The condition is observed rather than proven —
   * a third-party client module and a context provided through a rendered component are both
   * outside what the scan reads — so the preset decides whether it runs.
   */
  readonly directivesWithoutReason?: readonly DirectiveWithoutReason[];
  readonly closure: number;
  /** Files on the client side that declare nothing themselves. A fact, not a count of defects. */
  readonly reachedWithoutDeclaring: number;
  /** Specifiers that resolved nowhere, so the closure is smaller than the truth. */
  readonly unresolvedSpecifiers: number;
  /** Internal edges pointing at files the scan never read. */
  readonly unscannedEdges: number;
};

export const EMPTY_BOUNDARY: BoundaryReport = {
  leaks: [],
  closure: 0,
  reachedWithoutDeclaring: 0,
  unresolvedSpecifiers: 0,
  unscannedEdges: 0,
};

/**
 * Reads the closure for modules importing something the server alone provides. A leak is the edge
 * that was observed, not a claim about the build: a bundler may still shake that edge out.
 */
export function buildBoundary(
  index: SourceIndex,
  graph: ModuleGraph,
  options: { readonly examineDirectives?: boolean } = {},
): BoundaryReport {
  const leaks: BoundaryLeak[] = [];

  for (const path of graph.clientClosure) {
    const file = index.byPath.get(path);
    if (!file) continue;
    for (const reference of file.moduleReferences) {
      if (reference.typeOnly || !SERVER_MODULES.has(reference.specifier)) continue;
      leaks.push({ module: path, specifier: reference.specifier, chain: chainTo(graph, path) });
    }
  }
  leaks.sort((a, b) => {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    return a.specifier === b.specifier ? 0 : a.specifier < b.specifier ? -1 : 1;
  });

  return {
    leaks,
    ...(options.examineDirectives === true
      ? { directivesWithoutReason: directivesWithoutReason(index, graph) }
      : {}),
    closure: graph.clientClosure.size,
    reachedWithoutDeclaring: reachedWithoutDeclaring(graph).length,
    unresolvedSpecifiers: index.resolution.unresolved,
    unscannedEdges: graph.unscannedEdges,
  };
}

/**
 * Client entries that declare the directive and show none of the documented reasons for it.
 *
 * The three exclusions happen before the file's summary is read, because each answers a different
 * question from the one the summary answers. A test file is not production code. A file another
 * entry already reaches decides nothing about what ships, so its directive is redundant rather than
 * unargued. And a file importing a module another entry also reaches has its client code on the
 * client either way — what its own directive carries is what nothing else reaches.
 *
 * A fourth exclusion comes after it, and needs the summary to have been read first: a file showing
 * none of the six reasons may still be rendering a component it imported from client code, which is
 * a reason the file alone cannot show and the graph can.
 */
function directivesWithoutReason(
  index: SourceIndex,
  graph: ModuleGraph,
): readonly DirectiveWithoutReason[] {
  const found: DirectiveWithoutReason[] = [];

  for (const entry of graph.clientEntries) {
    const file = index.byPath.get(entry);
    if (!file || file.isTest || !file.clientReasons) continue;
    if (!showsNoReason(file.clientReasons)) continue;
    // The seventh reason, and the one the file alone cannot show: it renders a component it
    // imported from client code somewhere else, which is what the directive is there to allow.
    if (rendersAnImportedClientComponent(file, graph)) continue;

    const exclusive = graph.exclusiveReach.get(entry) ?? [];
    const alone = new Set(exclusive);
    const importsSharedClientCode = (graph.edges.get(entry) ?? []).some(
      (target) => target !== entry && graph.clientClosure.has(target) && !alone.has(target),
    );
    if (importsSharedClientCode) continue;

    found.push({ module: entry, exclusiveModules: exclusive.length });
  }

  // The largest first: what a reader looks at is the directive carrying the most, and the count is
  // the only ordering the graph can defend. Ties by path, so two runs agree.
  found.sort((a, b) => {
    if (a.exclusiveModules !== b.exclusiveModules) return b.exclusiveModules - a.exclusiveModules;
    return a.module === b.module ? 0 : a.module < b.module ? -1 : 1;
  });
  return found;
}
