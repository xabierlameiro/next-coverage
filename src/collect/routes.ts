import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type ConventionName, conventionOf, requiredFlagFor } from "./conventions.js";

/** How a directory contributes — or refuses to contribute — to the URL. */
export type DirectoryKind =
  | "static"
  | "dynamic"
  | "catch-all"
  | "optional-catch-all"
  /** `(marketing)` — organises files without adding a URL segment. */
  | "group"
  /** `@modal` — a parallel route slot, rendered as a layout prop. */
  | "slot"
  /** `(.)photo` — intercepts another route while keeping the current URL. */
  | "intercepting";

export type FoundConvention = {
  readonly name: ConventionName;
  readonly file: string;
  /** Set when the file differs from the reserved name only in casing. */
  readonly casingMismatch: boolean;
  /** Set when the convention needs a config flag that is off or unresolved. */
  readonly skippedForFlag?: string;
};

export type RouteNode = {
  readonly dirName: string;
  readonly kind: DirectoryKind;
  /** URL path of this node. Groups and slots inherit their parent's path. */
  readonly urlPath: string;
  readonly directory: string;
  readonly conventions: readonly FoundConvention[];
  /** Non-reserved files sitting next to the route. */
  readonly colocated: readonly string[];
  readonly children: readonly RouteNode[];
  /** Slot name without the `@`, present only when kind is `slot`. */
  readonly slotName?: string;
  /** Number of URL segments an intercepting route reaches up, `-1` for the root marker. */
  readonly interceptionDepth?: number;
};

export type TreeIssue =
  | { readonly kind: "route-page-conflict"; readonly urlPath: string; readonly directory: string }
  | {
      readonly kind: "route-group-collision";
      readonly urlPath: string;
      readonly directories: readonly string[];
    }
  | { readonly kind: "slot-without-default"; readonly slot: string; readonly directory: string }
  | { readonly kind: "casing-near-miss"; readonly file: string; readonly expected: string }
  | { readonly kind: "skipped-symlink"; readonly directory: string };

export type RouteTree = {
  readonly root: RouteNode;
  readonly nodes: readonly RouteNode[];
  readonly issues: readonly TreeIssue[];
  /** `children` is a slot every layout receives, with no directory of its own. */
  readonly implicitChildrenSlot: true;
};

const INTERCEPTION_MARKERS: readonly [string, number][] = [
  ["(...)", -1],
  ["(..)(..)", 2],
  ["(..)", 1],
  ["(.)", 0],
];

/**
 * The segment an intercepting directory names, with its marker stripped. Exported so a predicate
 * can work out what a route intercepts without re-stating the marker table, which is the one place
 * that knows `(..)(..)` is two levels and not a directory called `(..)`.
 */
export function interceptionSegment(dirName: string): string | undefined {
  const marker = INTERCEPTION_MARKERS.find(([prefix]) => dirName.startsWith(prefix));
  return marker === undefined ? undefined : dirName.slice(marker[0].length);
}

function classify(dirName: string): { kind: DirectoryKind; segment?: string; depth?: number } {
  for (const [marker, depth] of INTERCEPTION_MARKERS) {
    if (dirName.startsWith(marker)) {
      return { kind: "intercepting", segment: dirName.slice(marker.length), depth };
    }
  }
  if (dirName.startsWith("@")) return { kind: "slot" };
  if (dirName.startsWith("(") && dirName.endsWith(")")) return { kind: "group" };
  if (dirName.startsWith("[[...") && dirName.endsWith("]]")) {
    return { kind: "optional-catch-all", segment: dirName };
  }
  if (dirName.startsWith("[...") && dirName.endsWith("]")) {
    return { kind: "catch-all", segment: dirName };
  }
  if (dirName.startsWith("[") && dirName.endsWith("]")) {
    return { kind: "dynamic", segment: dirName };
  }
  return { kind: "static", segment: dirName };
}

function joinUrl(parent: string, segment: string | undefined): string {
  if (segment === undefined || segment === "") return parent;
  return parent === "/" ? `/${segment}` : `${parent}/${segment}`;
}

export type BuildOptions = {
  readonly appDirectory: string;
  readonly pageExtensions: readonly string[];
  /** Returns true only when the flag is known to be enabled. Unresolved must return false. */
  readonly isFlagEnabled: (flag: string) => boolean;
};

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * `readdirSync` reports a symlink as a link, never as a directory, so links have to be
 * resolved explicitly. A link staying inside the app directory is a normal directory and
 * is traversed; one escaping it is recorded and skipped, never silently dropped.
 */
function resolveEntry(
  appDirectory: string,
  path: string,
): { readonly traverse: boolean; readonly escaped: boolean } {
  try {
    const real = realpathSync(path);
    if (relative(appDirectory, real).startsWith("..")) return { traverse: false, escaped: true };
    return { traverse: statSync(real).isDirectory(), escaped: false };
  } catch {
    return { traverse: false, escaped: false };
  }
}

function buildNode(
  directory: string,
  dirName: string,
  parentUrl: string,
  options: BuildOptions,
  nodes: RouteNode[],
  issues: TreeIssue[],
): RouteNode {
  const { kind, segment, depth } = classify(dirName);
  const urlPath = kind === "group" || kind === "slot" ? parentUrl : joinUrl(parentUrl, segment);

  const conventions: FoundConvention[] = [];
  const colocated: string[] = [];
  const children: RouteNode[] = [];

  // Sorted so the tree never depends on filesystem enumeration order.
  const sorted = [...safeReadDir(directory)].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  for (const entry of sorted) {
    const full = join(directory, entry.name);

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      // Private folders are excluded from routing, and their contents are not scanned.
      if (entry.name.startsWith("_")) continue;
      if (entry.isSymbolicLink()) {
        const link = resolveEntry(options.appDirectory, full);
        if (link.escaped) {
          issues.push({ kind: "skipped-symlink", directory: full });
          continue;
        }
        if (!link.traverse) continue;
      }
      const child = buildNode(full, entry.name, urlPath, options, nodes, issues);
      children.push(child);
      continue;
    }

    if (!entry.isFile()) continue;
    const match = conventionOf(entry.name, options.pageExtensions);
    if (!match) {
      colocated.push(entry.name);
      continue;
    }
    if (match.casingMismatch) {
      issues.push({ kind: "casing-near-miss", file: full, expected: match.name });
      colocated.push(entry.name);
      continue;
    }
    const flag = requiredFlagFor(match.name);
    conventions.push(
      flag && !options.isFlagEnabled(flag)
        ? { name: match.name, file: full, casingMismatch: false, skippedForFlag: flag }
        : { name: match.name, file: full, casingMismatch: false },
    );
  }

  const active = conventions.filter((c) => c.skippedForFlag === undefined);
  if (active.some((c) => c.name === "route") && active.some((c) => c.name === "page")) {
    issues.push({ kind: "route-page-conflict", urlPath, directory });
  }
  if (kind === "slot" && !active.some((c) => c.name === "default")) {
    issues.push({ kind: "slot-without-default", slot: dirName, directory });
  }

  const node: RouteNode = {
    dirName,
    kind,
    urlPath,
    directory,
    conventions,
    colocated,
    children,
    ...(kind === "slot" ? { slotName: dirName.slice(1) } : {}),
    ...(depth === undefined ? {} : { interceptionDepth: depth }),
  };
  nodes.push(node);
  return node;
}

/** Builds the segment tree, keeping directories and URL segments strictly separate. */
/**
 * Directories serving a page, keyed by the URL they serve it on.
 *
 * Walked from the root rather than compared between siblings: two groups colliding on `/about`
 * live under different parents, so a per-parent comparison never sees them. It caught that case
 * only by noticing the groups themselves shared `/`, which reported the wrong URL for the right
 * problem — and fired on every project organising with groups.
 *
 * Slots and intercepting routes are skipped. Both deliberately serve a URL another route already
 * serves; that is the feature, not a collision.
 */
function pagesByUrl(node: RouteNode, found: Map<string, string[]>): Map<string, string[]> {
  if (node.kind === "slot" || node.kind === "intercepting") return found;
  if (node.conventions.some((c) => c.name === "page" && c.skippedForFlag === undefined)) {
    found.set(node.urlPath, [...(found.get(node.urlPath) ?? []), node.directory]);
  }
  for (const child of node.children) pagesByUrl(child, found);
  return found;
}

export function buildRouteTree(options: BuildOptions): RouteTree {
  const nodes: RouteNode[] = [];
  const issues: TreeIssue[] = [];
  // The boundary is compared against real paths, so it must be one itself: on macOS
  // /var is a link to /private/var, which would make every inner link look escaped.
  let boundary = options.appDirectory;
  try {
    boundary = realpathSync(options.appDirectory);
  } catch {
    boundary = options.appDirectory;
  }
  const root = buildNode(
    options.appDirectory,
    "",
    "/",
    { ...options, appDirectory: boundary },
    nodes,
    issues,
  );
  for (const [urlPath, directories] of pagesByUrl(root, new Map())) {
    if (directories.length > 1) {
      issues.push({ kind: "route-group-collision", urlPath, directories });
    }
  }

  return { root, nodes, issues, implicitChildrenSlot: true };
}

/**
 * Every URL a page or route handler actually answers on.
 *
 * Metadata files answer on URLs too, and `next dev` lists `/sitemap.xml`, `/robots.txt` and
 * `/icon` as entry points of their own. They stay out of here on purpose: the sitemap
 * heuristic in `catalog/metadata.ts` counts these URLs to decide whether there is anything
 * worth listing, and a sitemap does not list itself. Metadata conventions have their own
 * predicates, so counting them twice would only weaken both.
 */
export function routableUrls(tree: RouteTree): readonly string[] {
  const urls = new Set<string>();
  for (const node of tree.nodes) {
    const serves = node.conventions.some(
      (c) => c.skippedForFlag === undefined && (c.name === "page" || c.name === "route"),
    );
    if (serves) urls.add(node.urlPath);
  }
  return [...urls].sort();
}

/**
 * Every URL a page renders, which is the other question the tree answers about what it serves.
 *
 * `routableUrls` asks whether a URL is answered at all, and a route handler answers on its path
 * exactly as a page does — a `revalidatePath` naming one is a real invalidation. This asks what a
 * crawler could index, so a route handler contributes nothing: a sitemap does not list an API
 * endpoint. Counting them there reports a figure the suggestion is not about, which is what it did.
 *
 * Read off the same walk that finds route group collisions, rather than a second pass over the flat
 * node list. Slots and intercepting routes are skipped there because both deliberately serve a URL
 * another route already serves, and that is the reason to skip them here too. Under `routableUrls`
 * a slot happens to collapse into its parent because their URL paths coincide; a reading about
 * pages should not rest on the coincidence.
 */
export function pageUrls(tree: RouteTree): readonly string[] {
  return [...pagesByUrl(tree.root, new Map()).keys()].sort();
}

/**
 * Dynamic pages that do not generate their params, split by whether a measurement has answered
 * for them.
 *
 * `withdrawn` is what a build already settled: a route it prerendered is one where "this renders
 * on demand instead of being prerendered" is contradicted by the project's own output. `kept` is
 * what a report may still say. With no build every route is kept, which is why a condition reading
 * this stays at the tier of its source reading.
 *
 * One definition, because two would drift: the condition reports `kept` and the contrast counts
 * `withdrawn`, and a rule that decided them separately would eventually disagree with itself.
 */
export type UnprerenderedDynamicPages = {
  readonly kept: readonly RouteNode[];
  readonly withdrawn: readonly RouteNode[];
};

export function dynamicPagesWithoutStaticParams(
  tree: RouteTree,
  hasStaticParams: (pageFile: string) => boolean,
  isPrerendered: (segment: string) => boolean,
): UnprerenderedDynamicPages {
  const kept: RouteNode[] = [];
  const withdrawn: RouteNode[] = [];
  for (const node of tree.nodes) {
    const isDynamic =
      node.kind === "dynamic" || node.kind === "catch-all" || node.kind === "optional-catch-all";
    if (!isDynamic) continue;
    const page = node.conventions.find(
      (convention) => convention.name === "page" && convention.skippedForFlag === undefined,
    );
    if (page === undefined) continue;
    if (hasStaticParams(page.file)) continue;
    if (isPrerendered(node.directory)) withdrawn.push(node);
    else kept.push(node);
  }
  return { kept, withdrawn };
}
