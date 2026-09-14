import { createClientReach, type ModuleGraph } from "./graph.js";
import type { RouteJoin } from "./output.js";
import type { RouteNode, RouteTree } from "./routes.js";
import type { SourceIndex } from "./sources.js";

/** The client code one URL carries, and where it was derived from. */
export type RouteWeight = {
  readonly url: string;
  /** The client-side modules every route serving this URL reaches, as a set: a module both a
   * page and its layout reach ships once. */
  readonly modules: ReadonlySet<string>;
  /** The build's keys for the routes making up this URL, so a figure can be joined to it. */
  readonly filePathRoutes: readonly string[];
  /** The convention files walked: the pages serving this URL and the layouts around them. */
  readonly entries: readonly string[];
};

export type WeightReport = {
  /** Heaviest first, by module count. */
  readonly routes: readonly RouteWeight[];
  /**
   * Whether the URLs were taken from the build or derived here. The build is the authority on what
   * a file-path route serves — it is the only side that separates an intercepting route from the
   * one it intercepts — so its answer is used whenever there is one.
   */
  readonly urlSource: "build" | "derived";
};

export const EMPTY_WEIGHTS: WeightReport = { routes: [], urlSource: "derived" };

/** Only these serve a URL. A layout wraps them; a route handler ships no client code. */
const PAGE = "page";
const LAYOUT = "layout";

/**
 * Every route of the tree with the convention files that render it: its own page, and each layout
 * it inherits, because a layout renders around every route beneath it and its client imports ship
 * with them.
 */
function pagesWithLayouts(tree: RouteTree): { node: RouteNode; page: string; entries: string[] }[] {
  const found: { node: RouteNode; page: string; entries: string[] }[] = [];

  const walk = (node: RouteNode, inherited: readonly string[]): void => {
    const own = node.conventions
      .filter((c) => c.name === LAYOUT && c.skippedForFlag === undefined)
      .map((c) => c.file);
    const layouts = [...inherited, ...own];

    for (const convention of node.conventions) {
      if (convention.name !== PAGE || convention.skippedForFlag !== undefined) continue;
      found.push({ node, page: convention.file, entries: [convention.file, ...layouts] });
    }
    for (const child of node.children) walk(child, layouts);
  };

  walk(tree.root, []);
  return found;
}

/**
 * The client code each route carries, attributed by walking the graph from what renders it.
 *
 * Needs no build: it is derived from source alone, and is reported whether or not one is present.
 * A build only changes which URL a route is filed under, and the join is passed in for that.
 */
export function buildWeights(
  tree: RouteTree,
  graph: ModuleGraph,
  index: SourceIndex,
  join?: RouteJoin,
): WeightReport {
  const reach = createClientReach(graph);
  // A co-located test reaches client components and is never bundled with the route. Counting one
  // attributes to a route code no browser receives, which is what the build's figures disagreed
  // with when this was measured.
  const isTest = (path: string): boolean => index.byPath.get(path)?.isTest === true;

  // The build separates an intercepting route from the one it intercepts and this tool's derived
  // path does not, so grouping by the build's URL keeps two different documents apart.
  const urlByPage = new Map<string, string>();
  const filePathRouteByPage = new Map<string, string>();
  for (const route of join?.routes ?? []) {
    urlByPage.set(route.conventionFile, route.url);
    filePathRouteByPage.set(route.conventionFile, route.filePathRoute);
  }

  type Row = { modules: Set<string>; filePathRoutes: string[]; entries: string[] };
  const byUrl = new Map<string, Row>();

  for (const { node, page, entries } of pagesWithLayouts(tree)) {
    const url = urlByPage.get(page) ?? node.urlPath;
    const row = byUrl.get(url) ?? { modules: new Set(), filePathRoutes: [], entries: [] };
    for (const path of reach(entries)) {
      if (!isTest(path)) row.modules.add(path);
    }
    const filePathRoute = filePathRouteByPage.get(page);
    if (filePathRoute !== undefined) row.filePathRoutes.push(filePathRoute);
    row.entries.push(...entries.filter((entry) => !row.entries.includes(entry)));
    byUrl.set(url, row);
  }

  const routes = [...byUrl]
    .map(([url, row]) => ({
      url,
      modules: row.modules,
      filePathRoutes: row.filePathRoutes,
      entries: row.entries,
    }))
    // Heaviest first, then by URL so repeated runs match.
    .sort((a, b) =>
      b.modules.size === a.modules.size
        ? a.url === b.url
          ? 0
          : a.url < b.url
            ? -1
            : 1
        : b.modules.size - a.modules.size,
    );

  return { routes, urlSource: join === undefined ? "derived" : "build" };
}

/** One route under both orderings, and how far apart they place it. */
export type RankedRoute = {
  readonly url: string;
  readonly modules: number;
  /** First-load bytes, as the build recorded them. Never a figure this tool derived. */
  readonly bytes: number;
  /** Position under the module counts, 1 being the most. Tied routes share an average rank. */
  readonly byModules: number;
  readonly byBytes: number;
  /** How far the two orderings place it apart. */
  readonly gap: number;
};

/**
 * What a pair on either side of the agreement is worth, in bytes. Published so that an ordering
 * wrong about routes which barely differ and one wrong about routes which differ a great deal
 * stop reading alike — the agreement figure itself cannot tell them apart.
 */
export type Separation = {
  /** Median byte difference across the pairs the two orderings place differently. */
  readonly whenDiffering: number;
  /** The same, across the pairs they place alike. */
  readonly whenAgreeing: number;
};

export type WeightContrast = {
  /**
   * How far the two orderings agree, from -1 to 1: concordant pairs less discordant ones over the
   * pairs where both sides state an order. Absent when fewer than two routes are comparable.
   *
   * A fact about this tool's derivation, not about the project: it says how good a proxy a count
   * of modules is for the weight this build produced.
   */
  readonly agreement?: number;
  /**
   * What a disagreement weighs against what an agreement does. Absent when either side has no
   * pairs, because a median over nothing is not zero.
   */
  readonly separation?: Separation;
  /**
   * Pairs both orderings place, which is the population the agreement is a proportion of. The
   * routes are what they were drawn from, and reporting only those reads as a figure over routes.
   */
  readonly orderedPairs: number;
  /** Routes carrying both a module count and a recorded figure. */
  readonly compared: number;
  /** Routes with no recorded figure, which the build does not record for a handler. */
  readonly withoutFigure: number;
  /** Every comparable route under both orderings, furthest apart first. */
  readonly ranked: readonly RankedRoute[];
  /** Those the two orderings place at different positions, furthest apart first. */
  readonly furthest: readonly RankedRoute[];
  /** Why no ordering was contrasted, absent when one was. */
  readonly reason?: string;
};

export const EMPTY_WEIGHT_CONTRAST: WeightContrast = {
  orderedPairs: 0,
  compared: 0,
  withoutFigure: 0,
  ranked: [],
  furthest: [],
  reason: "no build was read",
};

/**
 * Average ranks, so tied values share a position rather than being ordered arbitrarily. Descending:
 * rank 1 is the largest value.
 */
function ranksOf(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index }));
  order.sort((a, b) => b.value - a.value);

  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]?.value === order[start]?.value) end += 1;
    // Positions are 1-based, and a run of ties shares the average of the positions it spans.
    const shared = (start + 1 + (end + 1)) / 2;
    for (let i = start; i <= end; i += 1) {
      const entry = order[i];
      if (entry !== undefined) ranks[entry.index] = shared;
    }
    start = end + 1;
  }
  return ranks;
}

/**
 * Concordant pairs less discordant ones, over the pairs neither side leaves tied. A pair tied on
 * either side states no order there, so breaking it would report an agreement or a disagreement
 * that neither the module counts nor the build ever claimed.
 *
 * With no ties this is Kendall's tau; with them it is the same ratio taken over the pairs that
 * remain, which is what "of the pairs both sides order, how many agree" means.
 */
function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The agreement, and what a pair on either side of it is worth.
 *
 * A rank correlation counts a pair the same whether the two routes differ by a kilobyte or by
 * eight hundred, so the figure alone cannot distinguish an ordering that is wrong about routes
 * which differ from one that is wrong about routes which do not. Measured across the corpus, the
 * second is what happens: the pairs the orderings place differently are separated by a median of
 * 1 kB, 5 kB and 15 kB on the three projects that carry a build, against 34 kB, 204 kB and 41 kB
 * for the pairs they agree on.
 */
function agreementOf(pairs: readonly (readonly [number, number])[]): {
  readonly agreement?: number;
  readonly separation?: Separation;
  readonly orderedPairs: number;
} {
  let concordant = 0;
  let discordant = 0;
  const agreeingGaps: number[] = [];
  const differingGaps: number[] = [];
  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      const a = pairs[i];
      const b = pairs[j];
      if (a === undefined || b === undefined) continue;
      const byModules = a[0] - b[0];
      const byBytes = a[1] - b[1];
      if (byModules === 0 || byBytes === 0) continue;
      if (byModules * byBytes > 0) {
        concordant += 1;
        agreeingGaps.push(Math.abs(byBytes));
      } else {
        discordant += 1;
        differingGaps.push(Math.abs(byBytes));
      }
    }
  }
  const ordered = concordant + discordant;
  if (ordered === 0) return { orderedPairs: 0 };
  const whenDiffering = medianOf(differingGaps);
  const whenAgreeing = medianOf(agreeingGaps);
  return {
    agreement: (concordant - discordant) / ordered,
    orderedPairs: ordered,
    // Absent when one side has no pairs at all: a median over nothing is not zero.
    ...(whenDiffering === undefined || whenAgreeing === undefined
      ? {}
      : { separation: { whenDiffering, whenAgreeing } }),
  };
}

/**
 * Contrasts the ordering the module counts imply against the one the build's recorded bytes imply.
 *
 * Only the orderings: a count of modules is not a count of bytes, and comparing the values would
 * be comparing two different things. What a difference says is that a module count is a poor proxy
 * for weight in this project — a fact about this tool, never a fault in the code.
 */
export function contrastWeights(
  report: WeightReport,
  bytesByUrl: ReadonlyMap<string, number>,
  reason?: string,
): WeightContrast {
  if (reason !== undefined) return { ...EMPTY_WEIGHT_CONTRAST, reason };

  const comparable = report.routes
    .map((route) => ({
      url: route.url,
      modules: route.modules.size,
      bytes: bytesByUrl.get(route.url),
    }))
    .filter(
      (row): row is { url: string; modules: number; bytes: number } => row.bytes !== undefined,
    );
  const withoutFigure = report.routes.length - comparable.length;

  if (comparable.length < 2) {
    return {
      orderedPairs: 0,
      compared: comparable.length,
      withoutFigure,
      ranked: [],
      furthest: [],
      reason: "fewer than two routes carry both a module count and a recorded figure",
    };
  }

  const byModules = ranksOf(comparable.map((row) => row.modules));
  const byBytes = ranksOf(comparable.map((row) => row.bytes));
  const ranked: RankedRoute[] = comparable.map((row, index) => {
    const modulesRank = byModules[index] ?? 0;
    const bytesRank = byBytes[index] ?? 0;
    return {
      url: row.url,
      modules: row.modules,
      bytes: row.bytes,
      byModules: modulesRank,
      byBytes: bytesRank,
      gap: Math.abs(modulesRank - bytesRank),
    };
  });
  ranked.sort((a, b) => (b.gap === a.gap ? (a.url < b.url ? -1 : 1) : b.gap - a.gap));

  const measured = agreementOf(comparable.map((row) => [row.modules, row.bytes] as const));
  return {
    ...(measured.agreement === undefined ? {} : { agreement: measured.agreement }),
    ...(measured.separation === undefined ? {} : { separation: measured.separation }),
    orderedPairs: measured.orderedPairs,
    compared: comparable.length,
    withoutFigure,
    ranked,
    furthest: ranked.filter((route) => route.gap > 0),
  };
}
