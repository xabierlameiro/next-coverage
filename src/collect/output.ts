import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { type NextConfigSource, readFlag, readFlagPresence } from "./config.js";
import { METADATA_CONVENTIONS } from "./conventions.js";
import { interceptionSegment, type RouteTree } from "./routes.js";
import { productionFiles, type SourceIndex } from "./sources.js";

const PRERENDER_MANIFEST = "prerender-manifest.json";
const APP_PATH_ROUTES_MANIFEST = "app-path-routes-manifest.json";
const ROUTE_BUNDLE_STATS = "diagnostics/route-bundle-stats.json";

/**
 * The modes a build records for a route it prerendered. There is no dynamic member: a route the
 * build did not prerender is absent from the manifest entirely, which is why a conclusion about
 * one is only sound against the build's own list of every route that exists.
 */
export const RENDERING_MODES = ["STATIC", "PARTIALLY_STATIC"] as const;

export type RenderingMode = (typeof RENDERING_MODES)[number];

/**
 * A concrete URL the build prerendered, and the route pattern it was generated from.
 *
 * `mode` is absent, not defaulted, for a route Next.js prerendered without PPR turned on: the
 * field is only written `isAppPPREnabled ? ... : undefined` by the build, so a route can be
 * prerendered — present in `routes` at all — with no mode recorded for it.
 */
export type PrerenderedRoute = {
  readonly url: string;
  readonly mode: RenderingMode | undefined;
  /** The dynamic route this URL came from, absent when the route is its own source. */
  readonly srcRoute?: string;
};

export type DynamicRoute = {
  readonly pattern: string;
  readonly mode: RenderingMode | undefined;
};

/** What the build recorded about the JavaScript one route loads first. */
export type RecordedWeights = {
  /** First-load uncompressed bytes, keyed by route URL. */
  readonly bytesByUrl: ReadonlyMap<string, number>;
  /** Entries skipped for a shape this tool does not read. */
  readonly unreadableEntries: number;
  /** Why there are no figures at all, absent when they were read. */
  readonly reason?: string;
};

export const NO_WEIGHTS: RecordedWeights = {
  bytesByUrl: new Map(),
  unreadableEntries: 0,
  reason: `.next holds no ${ROUTE_BUNDLE_STATS}`,
};

/**
 * The browser source maps the build wrote beside its client chunks.
 *
 * `reason` carries why there is no tally, and its presence is what separates *the build emitted
 * none* from *this could not look*. A directory it cannot read yields a reason rather than a zero,
 * because zero is an answer and an unreadable directory is not one.
 */
export type EmittedSourceMaps = {
  readonly count: number;
  readonly bytes: number;
  readonly reason?: string;
};

export type BuildOutput = {
  readonly buildId: string;
  /** The build's own answer to what URL a file-path route serves, keyed by the file-path route. */
  readonly routeUrls: ReadonlyMap<string, string>;
  readonly prerendered: ReadonlyMap<string, PrerenderedRoute>;
  readonly dynamicRoutes: ReadonlyMap<string, DynamicRoute>;
  /**
   * Entries whose shape this tool could not read, so nothing is known about their mode. Counted
   * rather than dropped: a manifest half-read is not a manifest read.
   */
  readonly unreadableEntries: number;
  /**
   * Per-route first-load figures, when the build recorded them. Their absence never makes the
   * build output unresolved: they feed one channel, and failing the rendering-mode contrast for
   * want of a diagnostics file would trade a working channel for one that is not.
   */
  readonly weights: RecordedWeights;
  /** What the build emitted beside its client chunks, for the option that asks for them. */
  readonly browserSourceMaps: EmittedSourceMaps;
};

/**
 * What reading the build produced. Stale is kept apart from unavailable because the two say
 * different things to a developer: one asks for a build, the other for a fresh one.
 */
export type BuildRead =
  | { readonly kind: "read"; readonly output: BuildOutput }
  | {
      readonly kind: "stale";
      readonly buildId: string;
      readonly newerFiles: number;
      /** The newest source file, so the reason names something the developer can look at. */
      readonly newest: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The manifest version this tool has been written against. */
const PRERENDER_MANIFEST_VERSION = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRenderingMode(value: unknown): value is RenderingMode {
  return typeof value === "string" && RENDERING_MODES.includes(value as RenderingMode);
}

/**
 * Reads the mode of one route entry. `renderingMode` absent is a build without PPR, which is
 * still a route it prerendered — that is a known unknown, not an unreadable one. Only a present
 * value this tool does not recognise is unreadable: that is a shape the manifest changed under it.
 */
function readEntryMode(
  value: unknown,
): { readonly ok: true; readonly mode: RenderingMode | undefined } | { readonly ok: false } {
  if (value === undefined) return { ok: true, mode: undefined };
  return isRenderingMode(value) ? { ok: true, mode: value } : { ok: false };
}

type ReadJson = { readonly kind: "ok"; readonly value: unknown } | { readonly kind: "missing" };

function readJson(path: string): ReadJson | { readonly kind: "malformed" } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { kind: "missing" };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "malformed" };
  }
}

type Manifests = {
  readonly prerendered: Map<string, PrerenderedRoute>;
  readonly dynamicRoutes: Map<string, DynamicRoute>;
  readonly unreadableEntries: number;
};

/**
 * Reads the prerender manifest into the two fields a contrast consumes. Unknown keys are ignored
 * rather than rejected: between 16.2.6 and 16.3.0 a route entry gained five of them while the
 * declared version did not move, so refusing on shape would turn a readable build into an
 * unreadable one.
 */
function readPrerenderManifest(value: unknown): Manifests | { readonly reason: string } {
  if (!isRecord(value)) return { reason: `${PRERENDER_MANIFEST} is not an object` };
  if (value.version !== PRERENDER_MANIFEST_VERSION) {
    return { reason: `${PRERENDER_MANIFEST} declares version ${String(value.version)}` };
  }
  const { routes, dynamicRoutes } = value;
  if (!isRecord(routes)) return { reason: `${PRERENDER_MANIFEST} has no readable routes` };
  if (!isRecord(dynamicRoutes)) {
    return { reason: `${PRERENDER_MANIFEST} has no readable dynamicRoutes` };
  }

  const prerendered = new Map<string, PrerenderedRoute>();
  const dynamics = new Map<string, DynamicRoute>();
  let unreadableEntries = 0;

  for (const [url, entry] of Object.entries(routes)) {
    if (!isRecord(entry)) {
      unreadableEntries += 1;
      continue;
    }
    const mode = readEntryMode(entry.renderingMode);
    if (!mode.ok) {
      unreadableEntries += 1;
      continue;
    }
    const srcRoute = typeof entry.srcRoute === "string" ? entry.srcRoute : undefined;
    prerendered.set(url, {
      url,
      mode: mode.mode,
      ...(srcRoute === undefined ? {} : { srcRoute }),
    });
  }

  for (const [pattern, entry] of Object.entries(dynamicRoutes)) {
    if (!isRecord(entry)) {
      unreadableEntries += 1;
      continue;
    }
    const mode = readEntryMode(entry.renderingMode);
    if (!mode.ok) {
      unreadableEntries += 1;
      continue;
    }
    dynamics.set(pattern, { pattern, mode: mode.mode });
  }

  return { prerendered, dynamicRoutes: dynamics, unreadableEntries };
}

function readRouteUrls(
  value: unknown,
):
  | { readonly urls: Map<string, string>; readonly unreadable: number }
  | { readonly reason: string } {
  if (!isRecord(value)) return { reason: `${APP_PATH_ROUTES_MANIFEST} is not an object` };
  const urls = new Map<string, string>();
  let unreadable = 0;
  for (const [filePathRoute, urlPath] of Object.entries(value)) {
    if (typeof urlPath !== "string") {
      unreadable += 1;
      continue;
    }
    urls.set(filePathRoute, urlPath);
  }
  return { urls, unreadable };
}

/**
 * The newest modification time among the files the build compiles, with how many of them are newer
 * than the build. A time that cannot be read counts as newer: an unverifiable build is not a
 * verified one, and this errs toward saying nothing.
 *
 * Tests are left out because the build never compiles one, so editing a spec cannot make the
 * output it wrote wrong. Counting them cost the whole contrast for a reason no reader could act
 * on: one `e2e` file touched after a build suppressed every rendering-mode and weight comparison.
 * This is the same rule the weight attribution already applies for the same reason.
 */
function sourcesNewerThan(
  sources: SourceIndex,
  builtAt: number,
): { count: number; newest: string } {
  let count = 0;
  let newestAt = Number.NEGATIVE_INFINITY;
  let newest = "";
  for (const file of productionFiles(sources)) {
    let modifiedAt: number;
    try {
      modifiedAt = statSync(file.path).mtimeMs;
    } catch {
      modifiedAt = Number.POSITIVE_INFINITY;
    }
    if (modifiedAt <= builtAt) continue;
    count += 1;
    if (modifiedAt > newestAt) {
      newestAt = modifiedAt;
      newest = file.path;
    }
  }
  return { count, newest };
}

/**
 * Reads the production build the project already produced. It never runs one: a build is an input
 * to find or do without, and a coverage tool that invokes the compiler is a different tool.
 *
 * Every refusal names what was missing. Absence of a build is not an error and never stops a run.
 */
/** The directory the framework writes a build to when the project configures none. */
const DEFAULT_DIST_DIR = ".next";

/**
 * Which directory holds the build, read from the project's own configuration.
 *
 * A project setting `distDir` puts its build somewhere else, and reading `.next` there finds either
 * nothing or a stale directory left by an earlier arrangement — the second being the worse failure,
 * because it answers. So a configured value that is not a string literal yields no directory at
 * all: this reader does not evaluate the configuration, and guessing `.next` for a project that has
 * said otherwise is the reading this rule exists to stop.
 */
function buildDirectoryOf(
  root: string,
  config: NextConfigSource | undefined,
): { readonly path: string; readonly name: string } | { readonly reason: string } {
  const present = readFlagPresence(config, "distDir");
  if (present.status !== "resolved" || !present.value) {
    return { path: join(root, DEFAULT_DIST_DIR), name: DEFAULT_DIST_DIR };
  }
  const value = readFlag(config, "distDir");
  if (value.status !== "resolved" || typeof value.value !== "string" || value.value === "") {
    return { reason: "distDir is configured and its value is not a string this reader can read" };
  }
  return { path: join(root, value.value), name: value.value };
}

export function readBuildOutput(
  root: string,
  sources: SourceIndex,
  config?: NextConfigSource,
): BuildRead {
  const directory = buildDirectoryOf(root, config);
  if ("reason" in directory) return { kind: "unavailable", reason: directory.reason };
  const { path: next, name: dist } = directory;

  let buildId: string;
  let builtAt: number;
  try {
    const idPath = join(next, "BUILD_ID");
    buildId = readFileSync(idPath, "utf8").trim();
    builtAt = statSync(idPath).mtimeMs;
  } catch {
    // Which of the two it is matters to the reader: a directory left by a build that compiled and
    // then failed is there to be looked at, and being told nothing was found at a path they can
    // see is a sentence they have to disprove before they can act on it.
    return existsSync(next)
      ? { kind: "unavailable", reason: `${dist} holds no BUILD_ID, so no build finished there` }
      : { kind: "unavailable", reason: `no production build found at ${dist}` };
  }
  if (buildId === "") {
    return { kind: "unavailable", reason: `${dist}/BUILD_ID is empty` };
  }

  const prerenderJson = readJson(join(next, PRERENDER_MANIFEST));
  if (prerenderJson.kind === "missing") {
    // A development server writes a partial build directory. Naming the manifest says which build
    // is wanted without guessing at how this one was produced.
    return { kind: "unavailable", reason: `${dist} holds no ${PRERENDER_MANIFEST}` };
  }
  if (prerenderJson.kind === "malformed") {
    return { kind: "unavailable", reason: `${dist}/${PRERENDER_MANIFEST} is not valid JSON` };
  }

  const routesJson = readJson(join(next, APP_PATH_ROUTES_MANIFEST));
  if (routesJson.kind === "missing") {
    return { kind: "unavailable", reason: `${dist} holds no ${APP_PATH_ROUTES_MANIFEST}` };
  }
  if (routesJson.kind === "malformed") {
    return { kind: "unavailable", reason: `${dist}/${APP_PATH_ROUTES_MANIFEST} is not valid JSON` };
  }

  const manifests = readPrerenderManifest(prerenderJson.value);
  if ("reason" in manifests) return { kind: "unavailable", reason: manifests.reason };

  const routeUrls = readRouteUrls(routesJson.value);
  if ("reason" in routeUrls) return { kind: "unavailable", reason: routeUrls.reason };

  // Staleness is decided last: a build that cannot be read at all is not worth ageing.
  const newer = sourcesNewerThan(sources, builtAt);
  if (newer.count > 0) {
    return { kind: "stale", buildId, newerFiles: newer.count, newest: newer.newest };
  }

  return {
    kind: "read",
    output: {
      buildId,
      weights: readWeights(join(next, ROUTE_BUNDLE_STATS)),
      browserSourceMaps: readBrowserSourceMaps(join(next, CLIENT_CHUNKS), dist),
      routeUrls: routeUrls.urls,
      prerendered: manifests.prerendered,
      dynamicRoutes: manifests.dynamicRoutes,
      unreadableEntries: manifests.unreadableEntries + routeUrls.unreadable,
    },
  };
}

/**
 * The per-route first-load figures, read with the same refusals as the manifests: an entry whose
 * shape this tool does not read is skipped and counted, never read as zero bytes.
 *
 * The file covers the pages of an app and no route handler, which is the set that ships JavaScript
 * to a browser. A route with no entry is not a gap.
 */
/** Where a build writes the client chunks, and the maps that would sit beside them. */
const CLIENT_CHUNKS = join("static", "chunks");

/**
 * Tallies the `.js.map` files beside the client chunks, walking the chunk directory once.
 *
 * Every failure yields a reason rather than a count. A build directory this cannot open is not a
 * build that emitted no maps, and the condition resting on this has to be able to tell the two
 * apart — reporting *the option is on and the build emitted nothing* about a directory nobody read
 * would be a finding about the reader.
 */
function readBrowserSourceMaps(chunkDirectory: string, dist: string): EmittedSourceMaps {
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(chunkDirectory, { withFileTypes: true, recursive: true });
  } catch {
    return { count: 0, bytes: 0, reason: `${dist} holds no ${CLIENT_CHUNKS} to read` };
  }
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js.map")) continue;
    try {
      bytes += statSync(join(entry.parentPath, entry.name)).size;
      count += 1;
    } catch {
      // A file that vanished between the listing and the stat. Counting it without its size would
      // report a tally the sum does not support.
    }
  }
  return { count, bytes };
}

function readWeights(path: string): RecordedWeights {
  const json = readJson(path);
  if (json.kind === "missing") return NO_WEIGHTS;
  if (json.kind === "malformed") {
    return { ...NO_WEIGHTS, reason: `.next/${ROUTE_BUNDLE_STATS} is not valid JSON` };
  }
  if (!Array.isArray(json.value)) {
    return { ...NO_WEIGHTS, reason: `.next/${ROUTE_BUNDLE_STATS} is not an array` };
  }

  const bytesByUrl = new Map<string, number>();
  let unreadableEntries = 0;
  for (const entry of json.value) {
    if (!isRecord(entry)) {
      unreadableEntries += 1;
      continue;
    }
    const { route, firstLoadUncompressedJsBytes: bytes } = entry;
    if (typeof route !== "string" || typeof bytes !== "number" || !Number.isFinite(bytes)) {
      unreadableEntries += 1;
      continue;
    }
    bytesByUrl.set(route, bytes);
  }
  return { bytesByUrl, unreadableEntries };
}

/** Why no build output is available, in words a report can print. */
export function unavailableReason(read: BuildRead): string | undefined {
  if (read.kind === "read") return undefined;
  if (read.kind === "unavailable") return read.reason;
  const files = read.newerFiles === 1 ? "1 file is" : `${read.newerFiles} files are`;
  return `the build predates the source: ${files} newer than it`;
}

/**
 * Which side of the join a route came out of, and what the build recorded for it. `mode` is
 * absent when the build prerendered the route without PPR turned on, so it named no mode at all —
 * that a route is prerendered and what mode it used are separate facts the manifest can answer
 * independently.
 */
export type RecordedMode =
  | { readonly kind: "prerendered"; readonly mode: RenderingMode | undefined }
  | { readonly kind: "not-prerendered" };

export type JoinedRoute = {
  /** The convention file this route is served by, so a finding can name a place in the source. */
  readonly conventionFile: string;
  /** The key the build's mapping uses, such as `/[lang]/(home)/page`. */
  readonly filePathRoute: string;
  readonly url: string;
  readonly segment: string;
  readonly recorded: RecordedMode;
};

export type UrlDisagreement = {
  readonly filePathRoute: string;
  readonly derived: string;
  readonly build: string;
};

/**
 * Entries of the build's mapping no route of the tree claimed, by what each one is. Only
 * `unexplained` is this tool's own gap: the other two are entries it located and did not join,
 * which is a different thing and was being reported as the same.
 */
export type UnjoinedEntries = {
  /** Metadata conventions, served under a key derived from the segment rather than the file. */
  readonly metadata: number;
  /** Routes Next.js supplies whether or not the project writes a file for them. */
  readonly framework: number;
  /** Everything else, and the only part worth a reader's attention. */
  readonly unexplained: number;
};

export type RouteJoin = {
  readonly routes: readonly JoinedRoute[];
  /** Routes of the tree the build's mapping does not mention. */
  readonly unjoinedRoutes: number;
  /** Entries of the build's mapping no route of the tree claimed. */
  readonly unjoined: UnjoinedEntries;
  readonly disagreements: readonly UrlDisagreement[];
};

export const EMPTY_JOIN: RouteJoin = {
  routes: [],
  unjoinedRoutes: 0,
  unjoined: { metadata: 0, framework: 0, unexplained: 0 },
  disagreements: [],
};

/**
 * What the build recorded for each segment it prerendered, keyed by the directory the route tree
 * knows the segment by. Only prerendered routes are listed: a segment the map does not hold is one
 * the build either recorded as not prerendered or never joined, and those are different silences
 * for a reader but the same answer for a claim asking whether prerendering happened.
 */
export function prerenderedBySegment(
  join: RouteJoin,
): ReadonlyMap<string, RenderingMode | undefined> {
  const modes = new Map<string, RenderingMode | undefined>();
  for (const route of join.routes) {
    if (route.recorded.kind === "prerendered") modes.set(route.segment, route.recorded.mode);
  }
  return modes;
}

/**
 * The conventions the build's route mapping keys on. Metadata conventions are served too, under a
 * key this tool does not derive — `opengraph-image.tsx` is listed as `.../opengraph-image/route` —
 * so they are left out of the join rather than matched by a rule invented from two examples.
 */
const JOINED_CONVENTIONS = new Set(["page", "route"]);

/** The mapping key for a convention file: its path under the app directory, without extension. */
function filePathRouteOf(appDirectory: string, file: string, convention: string): string {
  const segment = relative(appDirectory, dirname(file)).split(sep).filter(Boolean).join("/");
  return segment === "" ? `/${convention}` : `/${segment}/${convention}`;
}

/**
 * Joins the routes of this tool's tree to the build's, through the build's own file-to-URL
 * mapping rather than through the URL this tool derived. The mapping is Next.js answering the
 * same question, and where the two disagree that is a fact about this tool's derivation, kept
 * rather than absorbed.
 */
/**
 * Whether the build's URL and the derived one say the same thing.
 *
 * They disagree on notation for every intercepting route and always will: the build keeps `(.)` in
 * the string, as the key that holds an interception apart from the route it intercepts, and this
 * tool resolves it to the URL the interception answers on. `weight.ts` relies on that difference
 * rather than treating it as a fault, and reporting it as a disagreement told a reader nothing
 * they could act on.
 *
 * The marker is removed and the comparison still made, rather than skipping intercepting routes
 * outright: a route whose URL the two sides read differently for some other reason is exactly what
 * the figure exists to catch, and skipping would hide it.
 */
function agrees(build: string, derived: string): boolean {
  if (build === derived) return true;
  const stripped = build
    .split("/")
    .map((segment) => interceptionSegment(segment) ?? segment)
    .join("/");
  return stripped === derived;
}

/**
 * What an unclaimed mapping entry is.
 *
 * The metadata family is recognised, never mapped. Deriving the build's key from the file would
 * need `sitemap.ts` → `/sitemap.xml`, `manifest.ts` → `/manifest.webmanifest`, and a second axis
 * for the icon, where a generated one serves `/icon` and a static one `/icon.svg`. That table
 * would have to move with Next.js. Asking whether the segment names a convention the tree already
 * knows survives a renamed suffix and needs no table at all.
 *
 * `favicon` sits alongside the derived conventions: a `favicon.ico` is a file a project drops in
 * rather than a module, so the tree derives no convention from it, but the build serves it exactly
 * like the rest.
 */
function classifyUnjoined(key: string): keyof UnjoinedEntries {
  const segments = key.split("/").filter(Boolean);
  // `_not-found` and `_global-error`: the framework's own marker for a route it supplied.
  if (segments.some((segment) => segment.startsWith("_"))) return "framework";
  const served = segments.at(-2);
  if (served === undefined) return "unexplained";
  const known = [...METADATA_CONVENTIONS, "favicon"];
  return known.some((name) => served.startsWith(name)) ? "metadata" : "unexplained";
}

/** Counts the entries no route claimed, by what each one turned out to be. */
function unjoinedOf(routeUrls: ReadonlyMap<string, string>, claimed: ReadonlySet<string>) {
  const counts: Record<keyof UnjoinedEntries, number> = {
    metadata: 0,
    framework: 0,
    unexplained: 0,
  };
  for (const key of routeUrls.keys()) {
    if (claimed.has(key)) continue;
    counts[classifyUnjoined(key)] += 1;
  }
  return counts;
}

export function joinRoutes(tree: RouteTree, output: BuildOutput, appDirectory: string): RouteJoin {
  // One index of the prerendered URLs by the dynamic route they were generated from, so a
  // pattern can be answered without scanning every prerendered URL for each route.
  const bySrcRoute = new Map<string, PrerenderedRoute>();
  for (const route of output.prerendered.values()) {
    if (route.srcRoute !== undefined && !bySrcRoute.has(route.srcRoute)) {
      bySrcRoute.set(route.srcRoute, route);
    }
  }

  const routes: JoinedRoute[] = [];
  const disagreements: UrlDisagreement[] = [];
  const claimed = new Set<string>();
  let unjoinedRoutes = 0;

  for (const node of tree.nodes) {
    for (const convention of node.conventions) {
      if (!JOINED_CONVENTIONS.has(convention.name)) continue;
      if (convention.skippedForFlag !== undefined) continue;

      const filePathRoute = filePathRouteOf(appDirectory, convention.file, convention.name);
      const url = output.routeUrls.get(filePathRoute);
      if (url === undefined) {
        unjoinedRoutes += 1;
        continue;
      }
      claimed.add(filePathRoute);
      if (!agrees(url, node.urlPath)) {
        disagreements.push({ filePathRoute, derived: node.urlPath, build: url });
      }

      const exact = output.prerendered.get(url);
      const pattern = output.dynamicRoutes.get(url);
      const generated = bySrcRoute.get(url);
      const found = exact ?? pattern ?? generated;
      routes.push({
        conventionFile: convention.file,
        filePathRoute,
        url,
        segment: node.directory,
        recorded:
          found === undefined
            ? { kind: "not-prerendered" }
            : { kind: "prerendered", mode: found.mode },
      });
    }
  }

  routes.sort((a, b) =>
    a.filePathRoute === b.filePathRoute ? 0 : a.filePathRoute < b.filePathRoute ? -1 : 1,
  );
  disagreements.sort((a, b) =>
    a.filePathRoute === b.filePathRoute ? 0 : a.filePathRoute < b.filePathRoute ? -1 : 1,
  );

  return {
    routes,
    unjoinedRoutes,
    unjoined: unjoinedOf(output.routeUrls, claimed),
    disagreements,
  };
}
