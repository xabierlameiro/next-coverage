import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ConventionName } from "../collect/conventions.js";
import { proxyFiles } from "../collect/conventions.js";
import type { SurfaceEntry } from "../collect/docs.js";
import { reaching } from "../collect/graph.js";
import { attributeLiteral, isInternalPath } from "../collect/jsx.js";
import { interceptionSegment, type RouteNode, type RouteTree } from "../collect/routes.js";
import { callsResolvedTo, productionFiles } from "../collect/sources.js";
import { AUTH_INTERRUPTS, conventionFilePaths, GLOBAL_NOT_FOUND } from "./functions.js";
import type {
  NoSuggestion,
  Predicate,
  PredicateContext,
  PredicateSet,
  ReopenedFrom,
  Suggestion,
  SuggestionPredicate,
  Verdict,
} from "./types.js";
import { match, NO_MATCH, reasonFor, suggest } from "./types.js";

/** The reference groups every route segment config option under one directory. */
const ROUTE_SEGMENT_CONFIG = "file-conventions/route-segment-config/";

/**
 * Builds the predicate for a route segment config page, or nothing when the entry is not one.
 * Derived rather than authored, so an option a later version documents is detected by the
 * presence of its page.
 *
 * The symbol is the identifier's last segment, not the derived title that every other predicate
 * uses. `preferredRegion` is titled `preferredRegion (deprecated)`, so a title-derived symbol
 * would look for an export nobody declares and report a route file as clean while it declares
 * the option a hundred times over.
 */
export function routeSegmentConfigPredicate(entry: SurfaceEntry): PredicateSet | undefined {
  if (!entry.id.startsWith(ROUTE_SEGMENT_CONFIG)) return undefined;
  const symbol = entry.id.slice(ROUTE_SEGMENT_CONFIG.length);
  if (symbol === "" || symbol.includes("/")) return undefined;

  const removedBy = REMOVED_BY_FLAG[symbol];
  const dismissal =
    removedBy === undefined ? undefined : { notApplicable: removedByFlag(removedBy) };

  const detectUsed = (context: PredicateContext): Verdict => {
    // The same name exported from a helper module configures nothing, so only files the
    // route tree resolved as conventions count.
    const routes = conventionFilePaths(context);
    const files = context.sources.files
      .filter((file) => routes.has(file.path) && file.exportedNames.includes(symbol))
      .map((file) => file.path);
    return files.length === 0 ? NO_MATCH : match(files);
  };

  // An option whose abstention was reopened carries a condition instead of a reason, and the
  // sentence it used to answer with travels on the predicate. The three restatements share one
  // implementation, because their condition is one shape: the detection above, inverted.
  const restatement = SEGMENT_RESTATEMENTS[symbol];
  const condition =
    SEGMENT_CONDITION[symbol] ??
    (restatement === undefined
      ? undefined
      : noRouteDeclares(symbol, restatement.note, restatement.gain));
  if (condition !== undefined) {
    return {
      id: entry.id,
      cost: "AST",
      detectUsed,
      ...dismissal,
      wouldApplyStrict: condition,
      reopenedFrom: segmentReopening(entry.id, symbol),
      // The three whose condition is the detection above, inverted. Not a reading of the wording
      // but a property of the entry, which is what makes the mark checkable.
      ...(restatement === undefined ? {} : { restatesUsed: true as const }),
    };
  }

  return {
    id: entry.id,
    cost: "AST",
    detectUsed,
    ...dismissal,
    noSuggestion: SEGMENT_REASON[symbol] ?? {
      kind: "abstained",
      measuredAgainst: "16.3.0",
      why: "nothing in a route argues that it ought to carry a given segment option",
    },
  };
}

/**
 * The verdict a segment option answered with before its condition replaced it, read out of the map
 * that holds it rather than retyped here.
 *
 * Composed by the one function that turns a verdict into a sentence, so an examined row and an
 * abstained one read the way the report already reads them. Throws for a symbol with no row,
 * because a conversion of something nobody closed is what the register exists to catch.
 */
function segmentReopening(id: string, symbol: string): ReopenedFrom {
  const recorded = SEGMENT_REASON[symbol];
  const why = recorded === undefined ? undefined : reasonFor(recorded);
  if (why === undefined) throw new Error(`no recorded verdict for ${id}`);
  // By reference, whichever shape the row holds. Every one of these answered with the group's
  // abstention when the register was frozen, and `dynamicParams` gained its own measurement when
  // the group was split — so the sentence differs and the ground for withholding does not.
  return { from: id, why };
}

/**
 * Segment options the documentation states are unavailable under a configuration flag. The page
 * says it outright: *`dynamicParams` is not available when Cache Components is enabled*.
 *
 * This is why the obvious heuristic for it was not built. A route exporting
 * `generateStaticParams` without `dynamicParams` looks like a suggestion, and fired on 1 and 3
 * routes of the two fixtures — both of which enable the flag, so all four were routes that cannot
 * set the option. The fixture where it is available has none.
 */
const REMOVED_BY_FLAG: Readonly<Record<string, string>> = {
  dynamicParams: "cacheComponents",
};

function removedByFlag(flag: string): Predicate {
  return (context): Verdict => {
    if (!context.isFlagEnabled(flag)) return NO_MATCH;
    const configPath = context.project.config?.path;
    // The flag is only known enabled because the configuration was read, so this is present.
    return configPath === undefined
      ? NO_MATCH
      : match([configPath], `its documentation states it is unavailable under ${flag}`);
  };
}

/**
 * What each segment option would need before it could argue for itself; none of these is a
 * condition somebody has yet to type.
 */
const SEGMENT_REASON: Readonly<Record<string, NoSuggestion>> = {
  maxDuration: {
    kind: "abstained",
    measuredAgainst: "16.3.0",
    why: "nothing observable says how long a route takes, and guessing is not measuring",
  },
  runtime: {
    kind: "abstained",
    measuredAgainst: "16.3.0",
    why: "choosing edge over node is a deployment decision the code does not argue for",
  },
  prefetch: {
    kind: "abstained",
    measuredAgainst: "16.3.0",
    why: "how eagerly a route should be fetched is a product decision, not a property of its code",
  },
  // The three below took the group's fallback until it was split to argue each. The
  // fallback is about a directory of options and none of these three; reopening an entry that
  // carries it would be reopening something nobody closed, and the count of unexamined options
  // already reads a group reason as one rather than as three.
  //
  // `dynamicParams` is the only one whose measurement already existed: it is written in the comment
  // on `REMOVED_BY_FLAG` above, and moved here verbatim rather than rephrased.
  dynamicParams: {
    kind: "examined",
    measuredAgainst: "16.3.0",
    failed: "condition",
    condition:
      "a route exporting generateStaticParams without dynamicParams, which is the obvious heuristic for it",
    outcome:
      "it fired on 1 and 3 routes of the two versions measured, both of which enable Cache " +
      "Components — so all four were routes that cannot set the option, and the version where it " +
      "is available has none",
  },
  // Not dressed as an older measurement: nobody had examined either of these one at a time
  // before.
  instant: {
    kind: "abstained",
    measuredAgainst: "16.3.0",
    why: "what a navigation into a segment ought to feel like is a product expectation, and the page's own values are assertions an author makes rather than facts a route states",
  },
  preferredRegion: {
    kind: "abstained",
    measuredAgainst: "16.3.0",
    why: "where a route should run is a deployment decision, and its documentation title marks the option deprecated while its frontmatter declares no version, so a suggestion here would point at an option the reference is steering readers away from",
  },
};

/**
 * The conditions written for the segment options, keyed by symbol.
 *
 * Every one of them is withheld, and three of the four are restatements: a segment option is
 * detected by one thing — a route convention file exporting that name — so *no route exports it* is
 * the negation of the entry's own `detectUsed`, the same predicate with the answer flipped. That is
 * checkable rather than arguable, and assembly checks it.
 */
const SEGMENT_CONDITION: Readonly<Record<string, SuggestionPredicate>> = {
  /**
   * A route that generates its params and says nothing about the ones it did not list.
   *
   * The flag is tested here rather than left to the dismissal that runs before it. That dismissal
   * holds because of a chain — it matches only when the configuration path is known, and the path
   * is known whenever a flag is known enabled — written two functions away from this one. What is
   * recorded against this entry is that its obvious condition fired on four routes that could not
   * set the option; shipping the reopened one behind an ordering argument is how that comes back.
   */
  dynamicParams: (context): Suggestion => {
    if (context.isFlagEnabled("cacheComponents")) return NO_MATCH;
    const routes = conventionFilePaths(context);
    const files = context.sources.files
      .filter(
        (file) =>
          routes.has(file.path) &&
          file.exportedNames.includes("generateStaticParams") &&
          !file.exportedNames.includes("dynamicParams"),
      )
      .map((file) => file.path)
      .sort();
    return files.length === 0
      ? NO_MATCH
      : suggest(
          files,
          "these routes list the params they prerender and say nothing about the ones they did not",
          "the option decides whether a param outside the list is rendered on demand or answered with a not-found, which is the half the list leaves open",
        );
  },
  /**
   * A route every link into it turns prefetching off for.
   *
   * The page settles the shape: the values that mean anything are `'partial'` and
   * `'force-disabled'`, and it says *set this on the destination, not the link*. A project turning
   * prefetching off at every link into one route has already made that decision once per link; the
   * option is the same decision written where the page says it belongs.
   *
   * Gated on `cacheComponents` because the page states the export only works with it enabled.
   */
  prefetch: (context): Suggestion => {
    if (!context.isFlagEnabled("cacheComponents")) return NO_MATCH;
    const disabled = new Map<string, { off: number; total: number; files: Set<string> }>();
    for (const file of productionFiles(context.sources)) {
      for (const element of file.jsxElements) {
        if (element.tag !== "Link") continue;
        const href = attributeLiteral(element, "href");
        if (href === undefined || !isInternalPath(href)) continue;
        const seen = disabled.get(href) ?? { off: 0, total: 0, files: new Set<string>() };
        seen.total += 1;
        if (attributeLiteral(element, "prefetch") === "false") {
          seen.off += 1;
          seen.files.add(file.path);
        }
        disabled.set(href, seen);
      }
    }
    const files = new Set<string>();
    const routes: string[] = [];
    for (const [href, seen] of disabled) {
      if (seen.total === 0 || seen.off !== seen.total) continue;
      routes.push(href);
      for (const path of seen.files) files.add(path);
    }
    return routes.length === 0
      ? NO_MATCH
      : suggest(
          [...files].sort(),
          `every link into ${routes.sort().join(", ")} turns prefetching off, one link at a time`,
          "the option states it once on the destination, which the page says is where it belongs, and a link added later inherits it",
        );
  },
};

/**
 * The segment options whose only available condition is that no route declares them.
 *
 * Written because the owner asked for a condition on every entry, and marked because the sentence
 * is *this option exists and you are not using it* — the Used bucket read backwards. For these
 * three it is not a judgement about the wording: a segment option is detected by one thing, so the
 * condition is the negation of the entry's own detection, and assembly holds them to the mark.
 */
const SEGMENT_RESTATEMENTS: Readonly<Record<string, { note: string; gain: string }>> = {
  maxDuration: {
    note: "no route in this project sets a maximum duration",
    gain: "the option raises the ceiling a route may run to, which the platform otherwise sets for it",
  },
  runtime: {
    note: "no route in this project pins a runtime",
    gain: "the option pins the route to Node or to the edge instead of taking the framework's default",
  },
  instant: {
    note: "no route in this project states what a navigation into it should feel like",
    gain: "the option makes the framework surface the code that would keep a navigation from updating the UI immediately",
  },
};

/** The root layout, which is what a condition about the whole project cites. */
function rootLayoutOf(context: PredicateContext): string | undefined {
  return context.tree.root.conventions.find(
    (convention) => convention.name === "layout" && convention.skippedForFlag === undefined,
  )?.file;
}

/** The condition for a segment option nobody declares: the entry's own detection, inverted. */
function noRouteDeclares(symbol: string, note: string, gain: string): SuggestionPredicate {
  return (context): Suggestion => {
    const routes = conventionFilePaths(context);
    const declared = context.sources.files.some(
      (file) => routes.has(file.path) && file.exportedNames.includes(symbol),
    );
    if (declared) return NO_MATCH;
    const root = rootLayoutOf(context);
    return root === undefined ? NO_MATCH : suggest([root], note, gain);
  };
}

/** The directory kinds a route parameter is spelled with, in any of its three forms. */
const DYNAMIC_DIRECTORY_KINDS = new Set(["dynamic", "catch-all", "optional-catch-all"]);

/** Files of a given convention that Next.js will actually honour in this project. */
function filesFor(context: PredicateContext, name: ConventionName): string[] {
  return context.tree.nodes
    .flatMap((node) => node.conventions)
    .filter((convention) => convention.name === name && convention.skippedForFlag === undefined)
    .map((convention) => convention.file);
}

/**
 * Every segment directory of the route tree, marked with whether the convention is in effect
 * there — declared on the segment itself or inherited from an ancestor.
 *
 * The walk descends from the root carrying the answer, because `RouteNode` has children and no
 * parent pointer: adding one would make the tree cyclic, and deriving ancestry from the directory
 * strings would re-decide what the traversal already settled about symlinks and private folders.
 *
 * A convention Next.js skips for a disabled flag covers nothing, so it does not mark a segment.
 */
export function conventionCoverage(
  tree: RouteTree,
  name: ConventionName,
): ReadonlyMap<string, boolean> {
  const coverage = new Map<string, boolean>();
  const walk = (node: RouteNode, inherited: boolean): void => {
    const covered =
      inherited ||
      node.conventions.some(
        (convention) => convention.name === name && convention.skippedForFlag === undefined,
      );
    coverage.set(node.directory, covered);
    for (const child of node.children) walk(child, covered);
  };
  walk(tree.root, false);
  return coverage;
}

/**
 * Which segments have something to catch a `notFound()` call: a `not-found` file declared there or
 * above it, or a `global-not-found` file at the root.
 *
 * The two root files are equivalent for this question and for no other. The installed documentation
 * says both *"handle any unmatched URLs for your whole application"*, so covering a call under one
 * and not the other would assert a distinction the documentation does not draw — which is what the
 * reading did, telling three apps holding `app/global-not-found.tsx` that their calls landed on the
 * built-in page.
 *
 * `global-not-found` counts only at the root, unlike `not-found`, which covers its segment and
 * everything below it. Route discovery will record the convention wherever it finds the file, since
 * nothing there restricts it, and a file in a deep segment is one Next.js does not read as this
 * convention at all. Coverage is the place that has to know the difference.
 */
function notFoundCoverage(tree: RouteTree): ReadonlyMap<string, boolean> {
  const declared = conventionCoverage(tree, "not-found");
  const globalAtRoot = tree.root.conventions.some(
    (convention) =>
      convention.name === "global-not-found" && convention.skippedForFlag === undefined,
  );
  if (!globalAtRoot) return declared;
  return new Map([...declared].map(([directory]) => [directory, true]));
}

/**
 * The route segment a file sits in, found by walking up from the file. A file outside the app
 * directory belongs to no segment and returns nothing, so a helper module never stands in for a
 * route.
 */
function segmentOf(coverage: ReadonlyMap<string, boolean>, file: string): string | undefined {
  let directory = dirname(file);
  for (;;) {
    if (coverage.has(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * A convention Next.js reads from the project root. It accepts the file at the root or inside
 * `src`, so both are candidates for every name.
 */
function matchRootFile(context: PredicateContext, names: readonly string[]): Verdict {
  const found = names
    .flatMap((name) => [name, join("src", name)])
    .map((name) => join(context.project.root, name))
    .filter((path) => existsSync(path));
  return found.length === 0 ? NO_MATCH : match(found);
}

function usesConvention(name: ConventionName) {
  return (context: PredicateContext): Verdict => {
    const files = filesFor(context, name);
    return files.length === 0 ? NO_MATCH : match(files);
  };
}

function usesDirectoryKind(kind: "group" | "slot" | "intercepting" | "dynamic") {
  return (context: PredicateContext): Verdict => {
    const dirs = context.tree.nodes
      .filter((node) =>
        kind === "dynamic"
          ? node.kind === "dynamic" ||
            node.kind === "catch-all" ||
            node.kind === "optional-catch-all"
          : node.kind === kind,
      )
      .map((node) => node.directory);
    return dirs.length === 0 ? NO_MATCH : match(dirs);
  };
}

/**
 * Files Next.js ignores because their name differs from the convention only in case. `Page.tsx`
 * is not a page: the framework reads nothing there, so the author has a file they believe is a
 * route and a route that does not exist. One rename puts the convention in effect, which is what
 * makes this a would-apply rather than a defect report.
 */
function casingNearMiss(name: ConventionName): SuggestionPredicate {
  return (context: PredicateContext): Suggestion => {
    const misspelled = context.tree.issues
      .filter((issue) => issue.kind === "casing-near-miss" && issue.expected === name)
      .map((issue) => (issue.kind === "casing-near-miss" ? issue.file : ""));
    return misspelled.length === 0
      ? NO_MATCH
      : suggest(
          misspelled,
          `Next.js reads none of these; the name it looks for is '${name}'`,
          `named ${name}, the file is picked up as the convention it was written to be`,
        );
  };
}

/**
 * The first condition that holds, so an entry can carry two unrelated would-apply arguments
 * without merging their evidence into one finding nobody can read.
 */
function firstOf(...predicates: readonly SuggestionPredicate[]): SuggestionPredicate {
  return (context, surface) => {
    for (const predicate of predicates) {
      const verdict = predicate(context, surface);
      if (verdict.matched) return verdict;
    }
    return NO_MATCH;
  };
}

/**
 * A route convention file that calls the not-found function where no `not-found` file covers its
 * segment. Next.js then renders its own built-in page, which is a fact about what the reader gets
 * rather than a claim that the code is wrong.
 *
 * Only convention files count here. A helper module sitting under `app/` renders in whichever
 * segment imports it, and that is the module graph rather than the tree: attributing the call to
 * the directory holding the file names a segment that never renders. `uncaughtNotFoundInHelpers`
 * answers for those, out of the default preset.
 *
 * The call has to resolve to the framework import: a project with its own `notFound` helper is
 * using its own function, and telling it to adopt the convention would be a guess about a name.
 */
function uncaughtNotFoundCalls(context: PredicateContext): Suggestion {
  const coverage = notFoundCoverage(context.tree);
  const routes = conventionFilePaths(context);
  const uncovered = new Set<string>();
  for (const { file } of callsResolvedTo(context.sources, "next/navigation", "notFound")) {
    if (file.isTest || !routes.has(file.path)) continue;
    const segment = segmentOf(coverage, file.path);
    if (segment !== undefined && coverage.get(segment) === false) uncovered.add(file.path);
  }
  return uncovered.size === 0
    ? NO_MATCH
    : suggest(
        [...uncovered].sort(),
        "these call notFound() where no not-found file catches it, so it renders the built-in page",
        "a not-found file in the segment renders inside its layout when the function is called, instead of the root page",
      );
}

/**
 * The same condition for the modules the tree cannot place. A helper calling the function renders
 * in whichever segments import it, so the module graph names them: every route convention file
 * reaching the helper whose segment no `not-found` covers.
 *
 * Opt-in, and this is why. The graph joins files rather than symbols, so a route importing one name
 * from a barrel is credited with reaching every module behind it, this helper included. The finding
 * is therefore observed rather than proven, and the chain is printed in full so a reader can see
 * the barrel and dismiss it in one glance.
 *
 * A helper no route reaches says nothing about where the call renders, so it is not reported.
 */
function uncaughtNotFoundInHelpers(context: PredicateContext): Suggestion {
  const coverage = notFoundCoverage(context.tree);
  const routes = conventionFilePaths(context);
  const uncovered = new Set<string>();
  const root = context.project.root;
  for (const { file } of callsResolvedTo(context.sources, "next/navigation", "notFound")) {
    if (file.isTest || routes.has(file.path)) continue;
    for (const [route, chain] of reaching(context.graph, routes, file.path)) {
      const segment = segmentOf(coverage, route);
      // A chain is one line, not a path, so it is made readable here: the report relativises a
      // single path and would leave every file after the first one absolute.
      if (segment !== undefined && coverage.get(segment) === false) {
        uncovered.add(chain.map((path) => relative(root, path)).join(" → "));
      }
    }
  }
  return uncovered.size === 0
    ? NO_MATCH
    : suggest(
        [...uncovered].sort(),
        "these routes reach a module calling notFound() with no not-found file above them, so it renders the built-in page",
        "a not-found file above them renders inside the layout when the helper calls the function, instead of the root page",
      );
}

/** Pages that resolve something before they render, which is what a fallback fills. */
function asyncPages(context: PredicateContext): string[] {
  return filesFor(context, "page").filter((page) => {
    const source = context.sources.byPath.get(page);
    return source?.hasAsyncDefaultExport === true && !source.isTest;
  });
}

/**
 * Whether a file declares a boundary of its own, which is the other way to stream a fallback.
 *
 * A namespaced tag counts: `React.Suspense` and `Suspense` are the same element, and a file
 * importing the namespace rather than the name is not a file with no boundary in it.
 */
function streamsItself(context: PredicateContext, file: string): boolean {
  const source = context.sources.byPath.get(file);
  return (
    source?.jsxElements.some(
      (element) => element.tag === "Suspense" || element.tag.endsWith(".Suspense"),
    ) === true
  );
}

/**
 * The nearest declaration of a convention above each segment, by directory. A segment declaring
 * it answers with its own file.
 *
 * `conventionCoverage` answers whether a segment is covered; this answers by what. They are the
 * same walk, kept apart so a predicate asking only the yes-or-no question does not carry a map of
 * paths it never reads.
 */
function nearestConvention(tree: RouteTree, name: ConventionName): ReadonlyMap<string, string> {
  const nearest = new Map<string, string>();
  const walk = (node: RouteNode, inherited: string | undefined): void => {
    const own = node.conventions.find(
      (convention) => convention.name === name && convention.skippedForFlag === undefined,
    );
    const declared = own?.file ?? inherited;
    if (declared !== undefined) nearest.set(node.directory, declared);
    for (const child of node.children) walk(child, declared);
  };
  walk(tree.root, undefined);
  return nearest;
}

/**
 * A segment whose page resolves before it renders, with nothing above it to show meanwhile.
 *
 * A synchronous page is not reported: with nothing to await there is no interval for a fallback
 * to fill, and suggesting one would be an opinion about how the segment should fetch. The cost is
 * that a synchronous page rendering an async child is missed, which needs the module graph.
 *
 * A page rendering its own `Suspense` is not reported either. The convention is one of the two
 * ways the documentation gives to stream a fallback, and a page that took the other one has
 * nothing to adopt.
 */
function unstreamedAsyncPages(context: PredicateContext): Suggestion {
  const coverage = conventionCoverage(context.tree, "loading");
  const unstreamed = asyncPages(context).filter(
    (page) => coverage.get(dirname(page)) === false && !streamsItself(context, page),
  );
  return unstreamed.length === 0
    ? NO_MATCH
    : suggest(
        unstreamed.sort(),
        "these pages await before they render and nothing above them streams a fallback",
        "a loading file streams the layout first and shows the fallback while the page resolves",
      );
}

/**
 * A page whose fallback is declared further up than its own segment, under Cache Components.
 *
 * The flag turns the boundary into a statement about the prerender rather than only about
 * navigation: what sits outside the nearest one is the shell served before any data resolves. An
 * ancestor's fallback still covers the page, so nothing here is broken — but the shell prerendered
 * for it is that ancestor's, and everything the page could have rendered statically waits behind
 * it instead.
 *
 * Observed rather than proven, which is why it asks for `--strict` while the uncovered case does
 * not: a section deliberately showing one loading state across all of its routes is written this
 * way too, and no file says which of the two a project meant.
 */
function distantStreamingBoundary(context: PredicateContext): Suggestion {
  if (!context.isFlagEnabled("cacheComponents")) return NO_MATCH;
  const nearest = nearestConvention(context.tree, "loading");
  const root = context.project.root;
  const distant: string[] = [];
  for (const page of asyncPages(context)) {
    const segment = dirname(page);
    const fallback = nearest.get(segment);
    if (fallback === undefined || dirname(fallback) === segment) continue;
    if (streamsItself(context, page)) continue;
    // Two paths on one line, relativised here for the same reason the notFound chain is: the
    // report relativises a single path and would leave the second one absolute.
    distant.push(`${relative(root, page)} → ${relative(root, fallback)}`);
  }
  return distant.length === 0
    ? NO_MATCH
    : suggest(
        distant.sort(),
        "these pages await behind a fallback an ancestor declares, so the shell prerendered for them is that ancestor's rather than their own",
        "a loading file at the page's own segment moves the boundary down, so what the page renders without data is prerendered as its own shell instead of the ancestor's",
      );
}

function joinUrl(parent: string, segment: string): string {
  if (segment === "") return parent;
  return parent === "/" ? `/${segment}` : `${parent}/${segment}`;
}

/** Drops `count` segments from the end of a URL, stopping at the root. */
function upFrom(url: string, count: number): string {
  // `slice(0, -0)` is `slice(0, 0)`, so zero has to be answered before the arithmetic.
  if (count <= 0) return url;
  const segments = url.split("/").filter((segment) => segment !== "");
  return count >= segments.length ? "/" : joinUrl("/", segments.slice(0, -count).join("/"));
}

/** The URL segments a child adds to its parent, or nothing when it adds none. */
function relativeUrl(parent: string, child: string): string | undefined {
  if (child === parent) return undefined;
  const suffix = parent === "/" ? child.slice(1) : child.slice(parent.length + 1);
  return suffix === "" ? undefined : suffix;
}

/**
 * The URL an intercepting directory reaches for. The marker counts *route* segments, so the URL
 * built by the traversal is the right thing to walk up: groups and slots contribute none to it,
 * which is exactly what the documentation says the convention ignores.
 *
 * A marker this tool cannot resolve returns nothing and therefore covers nothing, so an
 * unreadable interception never silences a suggestion by accident.
 */
function interceptionTarget(node: RouteNode, parentUrl: string): string | undefined {
  const segment = interceptionSegment(node.dirName);
  if (segment === undefined || node.interceptionDepth === undefined) return undefined;
  // `(...)` reaches the root rather than a number of levels up.
  const base = node.interceptionDepth === -1 ? "/" : upFrom(parentUrl, node.interceptionDepth);
  return joinUrl(base, segment);
}

/** Every URL some intercepting route in the project resolves to, pages included. */
function interceptedUrls(tree: RouteTree): ReadonlySet<string> {
  const urls = new Set<string>();
  const collect = (node: RouteNode, target: string): void => {
    urls.add(target);
    for (const child of node.children) {
      // A child of an intercepting route keeps its own shape, so its URL extends the target.
      // The suffix comes from the URL, not the directory name: a group or slot adds none, and a
      // nested interception's name still carries its marker.
      const suffix = relativeUrl(node.urlPath, child.urlPath);
      collect(child, suffix === undefined ? target : joinUrl(target, suffix));
    }
  };
  const walk = (node: RouteNode, parentUrl: string): void => {
    if (node.kind === "intercepting") {
      const target = interceptionTarget(node, parentUrl);
      if (target !== undefined) collect(node, target);
    }
    for (const child of node.children) walk(child, node.urlPath);
  };
  walk(tree.root, tree.root.urlPath);
  return urls;
}

/**
 * A dynamic segment with a page directly under a segment with a page of its own: the list and
 * detail shape the documentation's own example uses, where the detail is entered from the listing.
 *
 * Whether the project wants that detail overlaid is not decidable from the tree, which is why the
 * heuristic is opt-in and the note describes the shape rather than prescribing a modal.
 */
function unInterceptedDetailRoutes(context: PredicateContext): Suggestion {
  const intercepted = interceptedUrls(context.tree);
  const hasPage = (node: RouteNode): boolean =>
    node.conventions.some((c) => c.name === "page" && c.skippedForFlag === undefined);
  const found: string[] = [];
  const walk = (node: RouteNode): void => {
    for (const child of node.children) {
      const isDetail =
        (child.kind === "dynamic" ||
          child.kind === "catch-all" ||
          child.kind === "optional-catch-all") &&
        hasPage(child);
      if (isDetail && hasPage(node) && !intercepted.has(child.urlPath)) found.push(child.directory);
      walk(child);
    }
  };
  walk(context.tree.root);
  return found.length === 0
    ? NO_MATCH
    : suggest(
        found.sort(),
        "these detail routes are entered from a listing and nothing intercepts them",
        "an intercepting route shows the detail over the listing on a client navigation, and the full page on a hard load or a shared link",
      );
}

/** A convention with a real structural trigger gets a heuristic; the rest honestly get none. */
const conventionOnly = (id: string, name: ConventionName, requiredFlag?: string): PredicateSet =>
  requiredFlag === undefined
    ? { id, cost: "FS", detectUsed: usesConvention(name), wouldApply: casingNearMiss(name) }
    : {
        id,
        cost: "FS",
        requiredFlag,
        detectUsed: usesConvention(name),
        wouldApply: casingNearMiss(name),
      };

/** Any of these declared means the project may compile MDX, so the convention is in question. */
const MDX_PACKAGES = [
  "@next/mdx",
  "@mdx-js/react",
  "@mdx-js/loader",
  "@mdx-js/mdx",
  "next-mdx-remote",
] as const;

/**
 * Packages whose own documentation makes a root file part of installing them. Kept as data rather
 * than folded into a name pattern: `next-mdx-remote` carries `mdx` and needs no file, and the same
 * trap waits on any substring rule over a manifest.
 */
const OBSERVABILITY_PACKAGES = [
  "@sentry/node",
  "@opentelemetry/api",
  "@opentelemetry/sdk-node",
  "@vercel/otel",
  "dd-trace",
  "newrelic",
] as const;

/** The names each root-file entry detects, read by its used detection and by its condition. */
const MDX_COMPONENTS_FILES = [
  "mdx-components.tsx",
  "mdx-components.ts",
  "mdx-components.jsx",
  "mdx-components.js",
] as const;
const INSTRUMENTATION_FILES = ["instrumentation.ts"] as const;
const INSTRUMENTATION_CLIENT_FILES = ["instrumentation-client.ts"] as const;

const CLIENT_MONITORING_PACKAGES = [
  "@sentry/browser",
  "@sentry/react",
  "@sentry/nextjs",
  "@vercel/analytics",
  "@vercel/speed-insights",
  "posthog-js",
] as const;

/**
 * A root convention argued for by a package the project declares. The evidence is the manifest,
 * because the manifest is what makes the case: the file is absent, and its absence is not itself
 * evidence of anything.
 *
 * The absence is read here rather than inherited from an ordering. This once relied on `detectUsed`
 * running first, which classification does — and then asks the condition anyway, because a used
 * entry may still be missing in places; that is the partial-adoption channel. So the report listed
 * `instrumentation-client.ts` under Used and, two lines down, said the file was not there. A
 * condition arguing from an absence is right wherever it is called from only if it establishes the
 * absence, and one held in a comment is a premise nobody checked.
 *
 * The names are the entry's own, read through the same helper its `detectUsed` reads, so the two
 * sides cannot come to disagree about whether a file is present.
 */
function declaredWithoutRootFile(
  names: readonly string[],
  packages: readonly string[],
  note: string,
  gain: string,
): SuggestionPredicate {
  return (context: PredicateContext): Suggestion => {
    if (matchRootFile(context, names).matched) return NO_MATCH;
    const declared = context.project.declaredPackages;
    if (declared.status !== "resolved") return NO_MATCH;
    const found = packages.filter((name) => declared.value.has(name));
    return found.length === 0
      ? NO_MATCH
      : suggest([join(context.project.root, "package.json")], `${note}: ${found.join(", ")}`, gain);
  };
}

/** How many sibling segments at the root make a group worth naming. Below this, nothing to group. */
const SEGMENTS_WANTING_A_GROUP = 8;

/**
 * A root with many sibling segments and no group. What counts as many is a threshold rather than a
 * fact, which is why the condition is opt-in: a flat root is a shape, not a defect.
 */
function flatRootWithManySegments(context: PredicateContext): Suggestion {
  // A project using groups anywhere has adopted the convention, and an entry the project adopts is
  // not one to argue for. Measured: a real project keeps its groups below `app/[lang]`, so a
  // root-only check reported it as missing a convention it uses throughout.
  if (context.tree.nodes.some((node) => node.kind === "group")) return NO_MATCH;
  const appPath = context.project.appDirectory.path;
  const siblings = context.tree.nodes.filter(
    (node) => dirname(node.directory) === appPath && node.kind !== "slot",
  );
  return siblings.length < SEGMENTS_WANTING_A_GROUP
    ? NO_MATCH
    : suggest(
        siblings.map((node) => node.directory),
        `the app root holds ${siblings.length} sibling segments and no group to organise them by`,
        "a route group organises segments under one directory and can carry its own layout without changing any URL",
      );
}

/** Extensions that make an absolute path an asset rather than a route. */
const ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
  ".mp4",
  ".webm",
  ".woff",
  ".woff2",
  ".pdf",
  ".txt",
  ".xml",
  ".json",
] as const;

const ASSET_ATTRIBUTES = ["src", "href", "poster", "srcSet"] as const;

/**
 * Absolute asset paths in a project with no `public` directory. The extension is what separates an
 * asset from a route: `href="/panel"` is navigation, `src="/retrato.png"` is a file the framework
 * would serve from `public`.
 *
 * The note says what the convention would organise. It does not say the path is broken — a rewrite
 * or a CDN may serve it, and this tool reports what a convention would cover, never a defect.
 */
function absoluteAssetsWithoutPublic(context: PredicateContext): Suggestion {
  if (existsSync(join(context.project.root, "public"))) return NO_MATCH;
  const files = context.sources.files
    .filter((file) => !file.isTest)
    .filter((file) =>
      file.jsxElements.some((element) =>
        ASSET_ATTRIBUTES.some((attribute) => {
          const value = element.attributes.get(attribute);
          if (value === undefined || value === "unresolved") return false;
          if (!value.literal.startsWith("/")) return false;
          return ASSET_EXTENSIONS.some((extension) =>
            value.literal.toLowerCase().endsWith(extension),
          );
        }),
      ),
    )
    .map((file) => file.path);
  return files.length === 0
    ? NO_MATCH
    : suggest(
        files,
        "these reference absolute asset paths, which is what a public directory serves",
        "files under public are served at the root URL as static assets",
      );
}

/** The layout of a segment, as a scanned file, or nothing when it has none the scan indexed. */
function layoutOf(context: PredicateContext, node: RouteNode) {
  const layout = node.conventions.find(
    (convention) => convention.name === "layout" && convention.skippedForFlag === undefined,
  );
  return layout === undefined ? undefined : context.sources.byPath.get(layout.file);
}

/** How many independently loading boundaries in one layout make slots worth naming. */
const BOUNDARIES_WANTING_SLOTS = 2;

/**
 * A layout composing several independently loading boundaries, in a segment declaring no slot.
 * That is the shape the convention's page gives as its reason to exist, read structurally.
 *
 * Observed rather than proven: composing boundaries by hand is a legitimate choice, and the note
 * says what was seen so a reader who made that choice can dismiss it without opening the file.
 */
function handRolledBoundaries(context: PredicateContext): Suggestion {
  const found = context.tree.nodes
    .filter((node) => !node.children.some((child) => child.kind === "slot"))
    .filter((node) => {
      const layout = layoutOf(context, node);
      if (layout === undefined) return false;
      const boundaries = layout.jsxElements.filter((element) => element.tag === "Suspense").length;
      return boundaries >= BOUNDARIES_WANTING_SLOTS;
    })
    .map((node) => node.directory);
  return found.length === 0
    ? NO_MATCH
    : suggest(
        found,
        "these layouts compose several independently loading boundaries and declare no slot",
        "a slot gives each region its own loading and error file, streamed independently of its siblings",
      );
}

/**
 * A client layout running an effect per navigation. A layout does not remount between sibling
 * routes, which is the difference the template convention's page names as its purpose, so writing
 * the effect against the pathname is doing by hand what a template gives.
 *
 * Observed, and reachable only where the casing condition on the same entry does not hold: a
 * proven condition that matches is returned before this one is evaluated.
 */
function clientLayoutWithPerNavigationEffect(context: PredicateContext): Suggestion {
  const found = context.tree.nodes
    .filter((node) => {
      const layout = layoutOf(context, node);
      if (layout === undefined) return false;
      if (!layout.fileDirectives.includes("use client")) return false;
      return layout.calledIdentifiers.has("useEffect");
    })
    .map((node) => node.directory);
  return found.length === 0
    ? NO_MATCH
    : suggest(
        found,
        "these client layouts run an effect per navigation, which is what a template is for",
        "a template remounts on every navigation, so the effect runs per page without the layout being a client component",
      );
}

export const ROUTING_PREDICATES: readonly PredicateSet[] = [
  conventionOnly("file-conventions/layout", "layout"),
  conventionOnly("file-conventions/page", "page"),
  {
    // AST rather than FS: whether a page awaits is a fact about its source, not its name.
    id: "file-conventions/loading",
    // `usesConvention` looks the file up in the route tree, which is built from names.
    cost: "FS",
    // Both conditions read the scanned sources — an async page with no boundary, and where the
    // boundary sits — and neither follows the module graph.
    conditionCost: "AST",
    detectUsed: usesConvention("loading"),
    // A misspelled file is the rarer and sharper finding, so it answers first when both hold.
    wouldApply: firstOf(casingNearMiss("loading"), unstreamedAsyncPages),
    // The proven argument is a segment with no fallback at all; this is the weaker one about
    // where the fallback sits, so it is held back on its own rather than by silencing the set.
    wouldApplyStrict: distantStreamingBoundary,
  },
  {
    // One page, several aspects: the docs document global-error inside error.md, so the
    // predicate for that page answers for both files rather than inventing a second entry.
    id: "file-conventions/error",
    cost: "FS",
    detectUsed: (context) => {
      const files = [...filesFor(context, "error"), ...filesFor(context, "global-error")];
      return files.length === 0 ? NO_MATCH : match(files);
    },
    wouldApply: (context) => {
      const hasSegmentBoundary = filesFor(context, "error").length > 0;
      const hasGlobal = filesFor(context, "global-error").length > 0;
      return hasSegmentBoundary && !hasGlobal
        ? suggest(
            filesFor(context, "error").slice(0, 1),
            "segment error boundaries exist but nothing catches a failing root layout",
            "a global-error file catches a failing root layout and renders in its place",
          )
        : NO_MATCH;
    },
  },
  {
    id: "file-conventions/not-found",
    // `FS`, because that is what every run pays here: `usesConvention` reads route-tree
    // conventions, which are built from file names and not from the scanned source index.
    cost: "FS",
    // The only set carrying two conditions that read different things. `uncaughtNotFoundCalls`,
    // under the default preset, never touches the graph; `uncaughtNotFoundInHelpers` is built on
    // `reaching(context.graph, …)`. One field cannot hold two tiers, so it holds the dearer, and
    // `conditionCostReadBy` records which condition performs that reading. Overstating is the safe
    // half — understating would deny a reading the set really performs — and the record is what
    // keeps it from being read as a claim about the default preset, whose cost `cost` states.
    conditionCost: "GRAFO",
    conditionCostReadBy: "strict",
    detectUsed: usesConvention("not-found"),
    wouldApply: firstOf(casingNearMiss("not-found"), uncaughtNotFoundCalls),
    wouldApplyStrict: uncaughtNotFoundInHelpers,
  },
  {
    // Two conditions, and the order matters: `casingNearMiss` is proven and returns first wherever
    // a miscased file exists, so the hand-rolled one is reachable only in a project with no
    // template file in any spelling. Written out rather than built from `conventionOnly`, which
    // returns a set with no second condition to add to.
    id: "file-conventions/template",
    // `FS`, because that is what `usesConvention` reads. The second condition reads a layout's
    // directives and calls, which is `AST` and is declared as the condition's tier — putting it
    // here would have said every run over this entry parses sources, and this one looks up a name.
    cost: "FS",
    conditionCost: "AST",
    detectUsed: usesConvention("template"),
    wouldApply: casingNearMiss("template"),
    wouldApplyStrict: clientLayoutWithPerNavigationEffect,
  },
  conventionOnly("file-conventions/route", "route"),
  conventionOnly("file-conventions/forbidden", "forbidden", AUTH_INTERRUPTS),
  conventionOnly("file-conventions/unauthorized", "unauthorized", AUTH_INTERRUPTS),
  conventionOnly("file-conventions/global-not-found", "global-not-found", GLOBAL_NOT_FOUND),

  {
    // A slot without a default 404s on refresh. That is a fact about Next.js, not an opinion.
    id: "file-conventions/default",
    cost: "FS",
    detectUsed: usesConvention("default"),
    wouldApply: (context) => {
      const missing = context.tree.issues
        .filter((issue) => issue.kind === "slot-without-default")
        .map((issue) => (issue.kind === "slot-without-default" ? issue.directory : ""));
      return missing.length === 0
        ? NO_MATCH
        : suggest(
            missing,
            "these parallel slots 404 on a hard navigation without a default",
            "a default file gives the slot something to render on a hard navigation instead of a 404",
          );
    },
  },

  {
    id: "file-conventions/route-groups",
    cost: "FS",
    detectUsed: usesDirectoryKind("group"),
    wouldApply: flatRootWithManySegments,
    wouldApplyPreset: "strict",
  },
  {
    id: "file-conventions/parallel-routes",
    // Reads the JSX of a layout, where detection alone reads directory names.
    cost: "AST",
    detectUsed: usesDirectoryKind("slot"),
    wouldApply: handRolledBoundaries,
    wouldApplyPreset: "strict",
  },
  {
    id: "file-conventions/intercepting-routes",
    cost: "FS",
    detectUsed: usesDirectoryKind("intercepting"),
    wouldApply: unInterceptedDetailRoutes,
    wouldApplyPreset: "strict",
  },
  {
    id: "file-conventions/dynamic-routes",
    // Detection reads a directory name; the condition parses a page. Declared apart so the entry
    // keeps the tier a default run pays for.
    cost: "FS",
    conditionCost: "AST",
    detectUsed: usesDirectoryKind("dynamic"),
    reopenedFrom: {
      from: "file-conventions/dynamic-routes",
      why: "whether a URL carries a parameter is what the product is, not a coverage finding",
    },
    // The weak member of the route conventions, and the proposal names it as the first to revert.
    // It answers half its objection and the smaller half: a page reading an identifier out of
    // `searchParams` has settled in code that the URL does carry a parameter. Which of the two
    // shapes should carry it — a query string or a path segment — is a decision about caching and
    // about how the page is linked to, and that half stands.
    //
    // Narrowed to a project whose route tree holds no dynamic segment anywhere, because a search
    // page, a filter and a paginated list all read `searchParams` and none of them wanted a
    // segment. A project that already has one has made the choice this would argue about.
    wouldApplyStrict: (context): Suggestion => {
      if (context.tree.nodes.some((node) => DYNAMIC_DIRECTORY_KINDS.has(node.kind)))
        return NO_MATCH;
      const routes = conventionFilePaths(context);
      const files = productionFiles(context.sources)
        .filter((file) => routes.has(file.path) && file.readsSearchParams)
        .map((file) => file.path)
        .sort();
      return files.length === 0
        ? NO_MATCH
        : suggest(
            files,
            "these routes read an identifier out of the query string, and no route in the project takes one as a segment",
            "a dynamic segment puts the value in the path, where the framework can prerender one page per value and a link can name the page rather than assemble a query",
          );
    },
  },

  {
    id: "file-conventions/src-folder",
    cost: "FS",
    detectUsed: (context) => {
      const appPath = context.project.appDirectory.path;
      return appPath.includes(`${join("src", "app")}`) ? match([appPath]) : NO_MATCH;
    },
    notApplicable: (context) => {
      const appPath = context.project.appDirectory.path;
      return appPath.includes(`${join("src", "app")}`)
        ? NO_MATCH
        : match([appPath], "the app directory already sits at the project root");
    },
    noSuggestion: {
      kind: "abstained",
      measuredAgainst: "16.3.0",
      why: "where a project puts its app directory is a layout choice, and either is supported",
    },
  },

  {
    id: "file-conventions/public-folder",
    // Reads the JSX of every file rather than the filesystem, which the neighbouring root
    // conventions do not need to.
    cost: "AST",
    detectUsed: (context) => {
      const path = join(context.project.root, "public");
      return existsSync(path) ? match([path]) : NO_MATCH;
    },
    wouldApply: absoluteAssetsWithoutPublic,
    wouldApplyPreset: "strict",
  },

  {
    id: "file-conventions/proxy",
    cost: "FS",
    detectUsed: (context) => {
      const found = proxyFiles(context.project.pageExtensions)
        .map((segments) => join(context.project.root, ...segments))
        .filter((path) => existsSync(path));
      return found.length === 0 ? NO_MATCH : match(found);
    },
    wouldApply: (context) => {
      // middleware.ts is the deprecated name in Next 16, and the codemod is one command.
      // Still worth saying when proxy.ts already exists: both files must not coexist.
      const legacy = ["middleware.ts", "middleware.js"]
        .map((name) => join(context.project.root, name))
        .filter((path) => existsSync(path));
      return legacy.length === 0
        ? NO_MATCH
        : suggest(
            legacy,
            "middleware is the deprecated name for proxy in Next 16",
            "proxy is the name this version reads, so the file keeps running once middleware stops being recognised",
          );
    },
  },

  {
    // The convention holds JSX, so a project normally writes it as a component. Checking only
    // the module extensions, as the neighbouring predicates do for their own conventions, would
    // report a project as missing a file sitting in its root.
    id: "file-conventions/mdx-components",
    cost: "FS",
    detectUsed: (context) => matchRootFile(context, MDX_COMPONENTS_FILES),
    // No MDX integration declared, no MDX to give components to. Any of the packages counts,
    // including the ones that do not themselves need this file: with one of them declared the
    // question of whether the project compiles MDX is live, and a dismissal that has to guess
    // is not one.
    notApplicable: (context) => {
      const declared = context.project.declaredPackages;
      if (declared.status !== "resolved") return NO_MATCH;
      if (MDX_PACKAGES.some((name) => declared.value.has(name))) return NO_MATCH;
      return match(
        [join(context.project.root, "package.json")],
        "the manifest declares no MDX integration to give components to",
      );
    },
    // `@next/mdx` alone, not any MDX package: its page states the file is required, and the others
    // never read it. A substring match on `mdx` would tell a project using `next-mdx-remote` to
    // adopt a convention its library ignores.
    wouldApply: declaredWithoutRootFile(
      MDX_COMPONENTS_FILES,
      ["@next/mdx"],
      "the manifest declares the MDX integration whose documentation states this file is required",
      "the file maps MDX elements to the project's components, so every compiled page renders with them",
    ),
  },
  {
    // The observation only. The suggestion to migrate lives on the proxy entry, which already
    // names this file as the deprecated spelling; repeating it here would print one finding twice.
    id: "file-conventions/middleware",
    cost: "FS",
    detectUsed: (context) => matchRootFile(context, ["middleware.ts", "middleware.js"]),
    noSuggestion: { kind: "delegated", to: "file-conventions/proxy", measuredAgainst: "16.3.0" },
  },
  {
    id: "file-conventions/instrumentation",
    cost: "FS",
    detectUsed: (context) => matchRootFile(context, INSTRUMENTATION_FILES),
    wouldApply: declaredWithoutRootFile(
      INSTRUMENTATION_FILES,
      OBSERVABILITY_PACKAGES,
      "the manifest declares an observability package with no instrumentation file to register it",
      "the register hook runs once when a server instance starts, before any request, which is where the package asks to be initialised",
    ),
    // The package list is a judgement of ours, and a package that needs no file would invent a
    // suggestion, so the condition is observed rather than proven.
    wouldApplyPreset: "strict",
  },
  {
    id: "file-conventions/instrumentation-client",
    cost: "FS",
    detectUsed: (context) => matchRootFile(context, INSTRUMENTATION_CLIENT_FILES),
    wouldApply: declaredWithoutRootFile(
      INSTRUMENTATION_CLIENT_FILES,
      CLIENT_MONITORING_PACKAGES,
      "the manifest declares a client monitoring package with no client instrumentation file",
      "the file runs before the app's client code on every page, which is where a monitoring package asks to be started",
    ),
    wouldApplyPreset: "strict",
  },
];
