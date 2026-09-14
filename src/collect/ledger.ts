import type { CallArgument } from "./calls.js";
import { readFlagList } from "./config.js";
import type { ProjectContext } from "./project.js";
import type { RouteTree } from "./routes.js";
import { routableUrls } from "./routes.js";
import type { SourceIndex } from "./sources.js";
import { callsResolvedTo } from "./sources.js";

/**
 * The modules a cache function is imported from, all of them the same function.
 *
 * `next/cache` is the documented one and the only one worth writing. The inner paths are there
 * because it re-exports from them verbatim — `use-cache/cache-tag` and `use-cache/cache-life` —
 * and real projects do import them: aurorascharff/next16-commerce tags four of its components
 * that way. Reading only the documented spelling made the ledger say nothing in the project
 * tagged `featured-product` while four files tagged it, which is a false statement about the
 * project rather than a narrower reading of it.
 *
 * Asking for a name under a module that does not export it finds nothing, so the extra paths
 * cost no precision: `revalidateTag` is not exported by the cache-tag module and is not found there.
 *
 * The functions catalog deliberately does NOT follow suit, and the asymmetry is the point. It
 * answers whether a project adopted the documented surface, and an inner path is not that surface,
 * so a file reaching past `next/cache` has not adopted it. This ledger answers a question of fact
 * — does anything in the project tag this — and a tag written through the inner path is tagged all
 * the same. Two questions, two readings.
 */
const CACHE_MODULE = [
  "next/cache",
  "next/dist/server/use-cache/cache-tag",
  "next/dist/server/use-cache/cache-life",
  "next/dist/esm/server/use-cache/cache-tag",
  "next/dist/esm/server/use-cache/cache-life",
] as const;
const TAG_PRODUCER = "cacheTag";
/** The deprecated helper, which produces through an option rather than through an argument. */
const OPTION_TAG_PRODUCER = "unstable_cache";
const TAG_CONSUMERS = ["revalidateTag", "updateTag"] as const;
const PATH_REVALIDATOR = "revalidatePath";

/**
 * How each documented function of the cache module relates to tags. Every one of them is here:
 * a producer, a consumer, or a reason it carries none.
 *
 * A ledger that does not know a producer reports the tags it produces as invalidated by nobody,
 * which is a false positive rather than a smaller report. Because the surface is derived from the
 * version the analysed project has installed, a release that adds such a function has to be noticed
 * rather than discovered through the finding it causes. The guard over this is a test: a stranger's
 * run is never failed for a gap of ours.
 */
export const TAG_SURFACE = {
  producers: [TAG_PRODUCER, OPTION_TAG_PRODUCER],
  consumers: TAG_CONSUMERS,
  withoutTags: {
    revalidatePath: "takes a path, matched against the route tree rather than against tags",
    cacheLife: "takes a profile name, which is a duration rather than a tag",
    refresh: "takes nothing: it refreshes the client router from a server action",
    unstable_noStore: "takes nothing: it opts a scope out of caching entirely",
    io: "marks a scope as doing input or output, and names no cache entry",
  },
} as const;

/** A declaration and the files it was declared in. */
export type Declaration = {
  readonly value: string;
  readonly files: readonly string[];
};

export type Ledger = {
  /** Tags produced but never invalidated anywhere in the project. */
  readonly orphanTags: readonly Declaration[];
  /** Tags invalidated but produced nowhere in the project. */
  readonly phantomTags: readonly Declaration[];
  /** Revalidated paths no route could serve. */
  readonly unmatchedPaths: readonly Declaration[];
  /** Packages a config list names that the manifest does not declare, keyed by the option. */
  readonly undeclaredPackages: ReadonlyMap<string, readonly Declaration[]>;
  /** Values excluded because they are not literals. Disclosed so the match is not read as total. */
  readonly unresolved: number;
};

function addTo(index: Map<string, Set<string>>, value: string, file: string): void {
  const files = index.get(value) ?? new Set<string>();
  files.add(file);
  index.set(value, files);
}

function declarationsOf(index: ReadonlyMap<string, Set<string>>, absent: ReadonlySet<string>) {
  return [...index]
    .filter(([value]) => !absent.has(value))
    .map(([value, files]) => ({ value, files: [...files].sort() }))
    .sort((a, b) => (a.value === b.value ? 0 : a.value < b.value ? -1 : 1));
}

/**
 * Turns a route path into a matcher. A concrete path counts as served when some route
 * could produce it, so matching is deliberately generous: a path is only ever reported
 * when no route serves it under any interpretation.
 */
function routeMatcher(route: string): RegExp {
  const body = route
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment.startsWith("[[...")) return "(?:/[^/]+)*";
      if (segment.startsWith("[...")) return "(?:/[^/]+)+";
      if (segment.startsWith("[")) return "/[^/]+";
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    })
    .join("");
  return new RegExp(`^${body === "" ? "/" : body}/?$`);
}

function isServedByAnyRoute(path: string, routes: readonly string[]): boolean {
  // A path written with dynamic segments is a pattern, and matches a route of that shape.
  if (path.includes("[")) return routes.includes(path);
  return routes.some((route) => routeMatcher(route).test(path));
}

/**
 * Every value in a list of tags, unlike `literalsOf`, which reads one argument position. A list is
 * read element by element so one computed tag does not lose the ones written beside it.
 */
function tagsIn(values: readonly CallArgument[]): { literals: string[]; unresolved: number } {
  const literals: string[] = [];
  let unresolved = 0;
  for (const value of values) {
    if (value === "unresolved") unresolved += 1;
    else literals.push(value.literal);
  }
  return { literals, unresolved };
}

function literalsOf(args: readonly CallArgument[]): { literals: string[]; unresolved: number } {
  const first = args[0];
  if (first === undefined) return { literals: [], unresolved: 0 };
  return first === "unresolved"
    ? { literals: [], unresolved: 1 }
    : { literals: [first.literal], unresolved: 0 };
}

/**
 * Builds the cross-file view: which tags the project produces, which it invalidates, and
 * which paths it revalidates. Only literal values enter, so a computed value can never
 * make a real declaration look unmatched.
 */
/**
 * Options holding a list of package names, paired with the catalog entry that documents each.
 * A promoted option keeps working under `experimental`, so both spellings are read.
 */
const PACKAGE_LISTS: readonly { readonly id: string; readonly paths: readonly string[] }[] = [
  {
    id: "config/next-config-js/serverExternalPackages",
    paths: ["serverExternalPackages", "experimental.serverExternalPackages"],
  },
  {
    id: "config/next-config-js/transpilePackages",
    paths: ["transpilePackages", "experimental.transpilePackages"],
  },
  {
    id: "config/next-config-js/optimizePackageImports",
    paths: ["optimizePackageImports", "experimental.optimizePackageImports"],
  },
];

/**
 * Packages a config list names and the manifest does not declare. A package the project has no
 * dependency on cannot be transpiled, externalised or optimised.
 *
 * Absence from the manifest, never absence from the imports: a transitive dependency can be
 * listed on purpose, because these options are about what the bundler does rather than about the
 * import graph.
 */
function undeclaredPackagesOf(project: ProjectContext): {
  readonly found: ReadonlyMap<string, readonly Declaration[]>;
  readonly unresolved: number;
} {
  const found = new Map<string, readonly Declaration[]>();
  // An unreadable manifest declares nothing and knows nothing; reporting every listed package as
  // undeclared would be the loudest possible way to be wrong.
  if (project.declaredPackages.status !== "resolved") return { found, unresolved: 0 };

  const declared = project.declaredPackages.value;
  const where = project.config?.path;
  let unresolved = 0;

  for (const { id, paths } of PACKAGE_LISTS) {
    const missing: Declaration[] = [];
    for (const path of paths) {
      // A branched list is taken as written: this asks which packages the config names, and one
      // named in either branch is named.
      const list = readFlagList(project.config, path);
      if (list.status !== "resolved") continue;
      unresolved += list.value.skipped;
      for (const name of list.value.values) {
        if (!declared.has(name)) missing.push({ value: name, files: where ? [where] : [] });
      }
    }
    if (missing.length > 0) found.set(id, missing);
  }
  return { found, unresolved };
}

export function buildLedger(
  sources: SourceIndex,
  tree: RouteTree,
  project: ProjectContext,
): Ledger {
  const produced = new Map<string, Set<string>>();
  const consumed = new Map<string, Set<string>>();
  const paths = new Map<string, Set<string>>();
  let unresolved = 0;

  for (const { file, call } of callsResolvedTo(sources, CACHE_MODULE, TAG_PRODUCER)) {
    const { literals, unresolved: skipped } = literalsOf(call.args);
    unresolved += skipped;
    for (const tag of literals) addTo(produced, tag, file.path);
  }

  // The deprecated helper tags through its options argument. A project still running it produces
  // those tags, so leaving them unread would report its invalidations as naming nothing.
  for (const { file, call } of callsResolvedTo(sources, CACHE_MODULE, OPTION_TAG_PRODUCER)) {
    const { literals, unresolved: skipped } = tagsIn(call.optionTags);
    unresolved += skipped;
    for (const tag of literals) addTo(produced, tag, file.path);
  }

  // Tagging a fetch is the other way to produce a tag, and a ledger that ignored it would
  // report every legacy-tagged project as invalidating tags that do not exist.
  for (const file of sources.files) {
    const { literals, unresolved: skipped } = tagsIn(file.fetchTags);
    unresolved += skipped;
    for (const tag of literals) addTo(produced, tag, file.path);
  }

  for (const consumer of TAG_CONSUMERS) {
    for (const { file, call } of callsResolvedTo(sources, CACHE_MODULE, consumer)) {
      const { literals, unresolved: skipped } = literalsOf(call.args);
      unresolved += skipped;
      for (const tag of literals) addTo(consumed, tag, file.path);
    }
  }

  for (const { file, call } of callsResolvedTo(sources, CACHE_MODULE, PATH_REVALIDATOR)) {
    const { literals, unresolved: skipped } = literalsOf(call.args);
    unresolved += skipped;
    for (const path of literals) addTo(paths, path, file.path);
  }

  const routes = routableUrls(tree);
  const servedPaths = new Set([...paths.keys()].filter((path) => isServedByAnyRoute(path, routes)));

  const packages = undeclaredPackagesOf(project);
  return {
    orphanTags: declarationsOf(produced, new Set(consumed.keys())),
    phantomTags: declarationsOf(consumed, new Set(produced.keys())),
    unmatchedPaths: declarationsOf(paths, servedPaths),
    undeclaredPackages: packages.found,
    unresolved: unresolved + packages.unresolved,
  };
}

export const EMPTY_LEDGER: Ledger = {
  undeclaredPackages: new Map(),
  orphanTags: [],
  phantomTags: [],
  unmatchedPaths: [],
  unresolved: 0,
};
