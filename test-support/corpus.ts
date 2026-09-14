import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PredicateContext } from "../src/catalog/types.js";
import { readFlag, readFlagPresence, readNextConfig } from "../src/collect/config.js";
import { buildGraph } from "../src/collect/graph.js";
import { EMPTY_JOIN } from "../src/collect/output.js";
import { discoverProject } from "../src/collect/project.js";
import { buildRouteTree } from "../src/collect/routes.js";
import { scanSources } from "../src/collect/sources.js";
import { DEFAULT_PAGE_EXTENSIONS, unresolved } from "../src/types.js";
import { once } from "./fixtures.js";

/**
 * The vendored projects that are wrong on purpose. Each one carries cases the others cannot: a
 * condition reading the whole project rather than one segment pins that project to a shape, and two
 * conditions wanting opposite shapes need two projects. See each fixture's README for which
 * properties it is pinned to.
 *
 * They are vendored rather than referenced, which is the opposite of the three in `fixtures.ts` and
 * for the opposite reason: those must drift with their real dependencies, and these must not move
 * at all. They are committed, so they run on a fresh clone where the others are skipped for absence.
 */
export const VENDORED = [
  "incomplete-app",
  "sparse-app",
  "unflagged-app",
  "overconfigured-app",
  "global-not-found-app",
  "handler-cache-app",
] as const;

export type Vendored = (typeof VENDORED)[number];

const CORPUS_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * The vendored monorepo, which is deliberately not one of the above.
 *
 * Every fixture in `VENDORED` resolves as a project, and this one cannot: pointing discovery at its
 * root now answers `workspace-root`, which is the behaviour it exists to demonstrate. It is a
 * fixture of the scan rather than of the catalog — what it pins down is which files are read and
 * how their imports resolve — so it is addressed directly by the tests that need it.
 */
export const WORKSPACE_FIXTURE = join(CORPUS_ROOT, "workspace-app");

/** The root of a vendored fixture. */
export function fixtureRoot(fixture: Vendored): string {
  return join(CORPUS_ROOT, fixture);
}

/** A fixture's files, by the path a verdict's evidence would name them. */
export function fileIn(fixture: Vendored, ...segments: readonly string[]): string {
  return join(fixtureRoot(fixture), ...segments);
}

/**
 * A context over a vendored fixture, built the way the catalog tests build one: the full pipeline
 * derives its surface from `node_modules/next/dist/docs/`, and a vendored project has no
 * `node_modules`. Everything a predicate actually reads — the tree, the sources, the graph, the
 * config — is real.
 *
 * Built once per fixture and shared: they do not change between assertions.
 */
export function fixtureContext(fixture: Vendored): PredicateContext {
  return once(`${fixture}-context`, () => projectContext(fixtureRoot(fixture)));
}

/**
 * The same context for any project root, vendored or referenced. Not cached: a caller reading a
 * referenced project once per suite wraps it in `once` itself.
 */
export function projectContext(root: string): PredicateContext {
  const discovery = discoverProject(root);
  if (discovery.kind !== "ok") {
    throw new Error(`${root} did not resolve as a project: ${discovery.reason.kind}`);
  }
  const { project } = discovery;
  const isFlagEnabled = (flag: string): boolean => {
    const value = readFlag(project.config, flag);
    return value.status === "resolved" && value.value === true;
  };
  const sources = scanSources(project.root);
  return {
    project,
    tree: buildRouteTree({
      appDirectory: project.appDirectory.path,
      pageExtensions:
        project.pageExtensions.status === "resolved"
          ? project.pageExtensions.value
          : DEFAULT_PAGE_EXTENSIONS,
      isFlagEnabled,
    }),
    sources,
    graph: buildGraph(sources),
    isFlagEnabled,
    // No build is read: the fixtures are never built, only read.
    build: unresolved("no build was read"),
    join: EMPTY_JOIN,
  };
}

/**
 * A whole-project property a fixture is pinned to. Conditions reading the project rather than a
 * segment depend on these, and nothing in a case says so: a later case adding a route group to a
 * fixture would silence `route-groups` without touching its test. Asserted directly, so taking one
 * away fails here and names the property rather than the condition that quietly stopped firing.
 */
export type PinnedProperty = {
  readonly describe: string;
  readonly holds: (root: string) => boolean;
};

const hasNoRouteGroup = (root: string): boolean =>
  !readdirSync(join(root, "app"), { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && entry.name.startsWith("("),
  );

const hasNoPublicDirectory = (root: string): boolean => !existsSync(join(root, "public"));

const namesUnder = (root: string): readonly string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      found.push(entry.name);
      if (entry.isDirectory()) walk(join(directory, entry.name));
    }
  };
  walk(join(root, "app"));
  return found;
};

const hasNoParallelSlot = (root: string): boolean =>
  !namesUnder(root).some((name) => name.startsWith("@"));

const hasNoTemplateInAnyCasing = (root: string): boolean =>
  !namesUnder(root).some((name) => name.toLowerCase().startsWith("template."));

const hasSitemapAndNoRobots = (root: string): boolean => {
  const names = namesUnder(root).map((name) => name.toLowerCase());
  const named = (convention: string): boolean =>
    names.some((name) => name.startsWith(`${convention}.`));
  return named("sitemap") && !named("robots");
};

const IMAGE_CONVENTIONS = [
  "icon.",
  "apple-icon.",
  "favicon.",
  "opengraph-image.",
  "twitter-image.",
];

const hasNoImageConvention = (root: string): boolean =>
  !namesUnder(root).some((name) =>
    IMAGE_CONVENTIONS.some((convention) => name.toLowerCase().startsWith(convention)),
  );

/**
 * The options whose absence every case in `unflagged-app` argues from, asked of the config the
 * way a predicate asks it. Grepping the file text would answer differently: the comments there
 * name the very options they exist to say are unset.
 */
const setsNoneOfTheOptions = (root: string): boolean => {
  const config = readNextConfig(root);
  return ["authInterrupts", "useOffline", "cacheLife", "urlImports", "globalNotFound"].every(
    (option) =>
      [option, `experimental.${option}`].every((path) => {
        const found = readFlag(config, path);
        return found.status === "resolved" && found.value === undefined;
      }),
  );
};

/**
 * The options `overconfigured-app` exists to make readable: every unexamined page whose name is a
 * key the configuration accepts. Asked of the config the way a predicate asks it, for the reason
 * `setsNoneOfTheOptions` is — the comments in that file name the options they discuss, so reading
 * the text would answer differently.
 *
 * Kept here rather than derived from `EXAMINATION_TRANCHES`: the groups it defines are a claim
 * about what is examinable, and checking a claim against itself proves nothing. A page that leaves the
 * remainder must fail here until someone takes it out of both.
 *
 * Asked by presence rather than by value, which is what `configOptionPredicate` reads. Most of
 * these options take an object, an array, a regular expression or a function, and `readFlag`
 * resolves scalars only — asking it for a value would report nine of them missing while the
 * configuration names every one.
 */
const CONFIGURED_OPTIONS = [
  "adapterPath",
  "allowedDevOrigins",
  "assetPrefix",
  "basePath",
  "cacheHandlers",
  "compress",
  "crossOrigin",
  "deploymentId",
  "devIndicators",
  "distDir",
  "expireTime",
  "exportPathMap",
  "generateEtags",
  "htmlLimitedBots",
  "httpAgentOptions",
  "instrumentationClientInject",
  "onDemandEntries",
  "outputHashSalt",
  "productionBrowserSourceMaps",
  "reactMaxHeadersLength",
  "supportsImmutableAssets",
  "trailingSlash",
  "experimental.cssChunking",
  "experimental.inlineCss",
  "experimental.prefetchInlining",
  "experimental.proxyClientMaxBodySize",
  "experimental.serverComponentsHmrCache",
  "experimental.turbopackChunking",
  "experimental.turbopackLocalPostcssConfig",
  "experimental.turbopackMemoryEviction",
  "experimental.useLightningcss",
  "experimental.useTypeScriptCli",
] as const;

const setsEveryReadableOption = (root: string): boolean => {
  const config = readNextConfig(root);
  return CONFIGURED_OPTIONS.every((path) => {
    const found = readFlagPresence(config, path);
    return found.status === "resolved" && found.value;
  });
};

/**
 * The five pages whose name is not a key of `NextConfig` in 16.3.0. Detection builds its lookup
 * from the page name, so no project can report them as used and setting one here would claim a
 * detectability that does not exist. The keys they correspond to are in the fixture's README.
 */
const NOT_WRITABLE_KEYS = [
  "appDir",
  "incrementalCacheHandlerPath",
  "staticGeneration",
  "turbopackFileSystemCache",
  "turbopackIgnoreIssue",
] as const;

const namesNoUndetectablePage = (root: string): boolean => {
  const config = readNextConfig(root);
  return NOT_WRITABLE_KEYS.every((option) =>
    [option, `experimental.${option}`].every((path) => {
      const found = readFlagPresence(config, path);
      return found.status === "resolved" && !found.value;
    }),
  );
};

/**
 * Both halves of the manifest trap. The named icon that exists is served from `public/`, and a
 * condition checking only the metadata conventions would report it — the false positive already
 * measured on a real project, before this fixture existed.
 */
const hasOneServedIconAndOneMissing = (root: string): boolean =>
  existsSync(join(root, "public", "logo-192.png")) &&
  !existsSync(join(root, "public", "logo-512.png")) &&
  readFileSync(join(root, "app", "manifest.ts"), "utf8").includes("/logo-512.png");

/**
 * Whether `cacheComponents` reads as enabled, asked of the config the way a predicate asks it.
 * One shape — a server fetch stating nothing about its caching — is carried by two entries under
 * opposite settings of this flag, so each side of the split needs a project pinned to its side.
 * Moving the flag on either project silences one case and makes the other report twice.
 */
const cacheComponentsEnabled = (root: string): boolean => {
  const found = readFlag(readNextConfig(root), "cacheComponents");
  return found.status === "resolved" && found.value === true;
};

/**
 * Whether the configuration writes a key at all, whatever value it gives it. Presence rather than
 * value, because a fixture pinned to "this option is absent" is pinned against every value of it.
 */
const writes = (root: string, key: string): boolean => {
  const found = readFlagPresence(readNextConfig(root), key);
  return found.status === "resolved" && found.value;
};

/**
 * A proxy the old reading could not see. It matched four literal names — `proxy.ts`, `proxy.js` and
 * the two under `src` — so a proxy under any other documented page extension was reported as no
 * proxy at all, by every reader that asks. Pinned to `.tsx` specifically: an edit renaming it to
 * `.ts` would make the case pass against the reading it exists to rule out.
 */
const hasProxyOutsideTheHistoricalNames = (root: string): boolean =>
  existsSync(join(root, "proxy.tsx")) &&
  !existsSync(join(root, "proxy.ts")) &&
  !existsSync(join(root, "proxy.js"));

/**
 * The convention `global-not-found-app` exists for, and the absence that makes it testable. The
 * flag has to be on for Next.js to run the file, and a `not-found` file anywhere would cover the
 * project's uncaught call for the ordinary reason — which is the reading this fixture is here to
 * distinguish from.
 */
const adoptsGlobalNotFound = (root: string): boolean => {
  const found = readFlag(readNextConfig(root), "experimental.globalNotFound");
  const names = namesUnder(root).map((name) => name.toLowerCase());
  return (
    found.status === "resolved" &&
    found.value === true &&
    names.some((name) => name.startsWith("global-not-found.")) &&
    !names.some((name) => name.startsWith("not-found."))
  );
};

export const PINNED: Record<Vendored, readonly PinnedProperty[]> = {
  "incomplete-app": [
    {
      describe: "no route group under app/, so `route-groups` can argue for one",
      holds: hasNoRouteGroup,
    },
    {
      describe: "no public directory, so `public-folder` can argue for one",
      holds: hasNoPublicDirectory,
    },
  ],
  "sparse-app": [
    {
      describe: "no parallel slot anywhere, so `parallel-routes` is not adopted here",
      holds: hasNoParallelSlot,
    },
    {
      describe: "no template file in any casing, so the casing condition cannot short-circuit",
      holds: hasNoTemplateInAnyCasing,
    },
    {
      describe: "a sitemap with no robots file, the shape incomplete-app cannot hold",
      holds: hasSitemapAndNoRobots,
    },
    {
      describe: "a proxy under an extension outside the four names the reading was written from",
      holds: hasProxyOutsideTheHistoricalNames,
    },
  ],
  "global-not-found-app": [
    {
      describe: "the flag on, a root global-not-found file, and no not-found file anywhere",
      holds: adoptsGlobalNotFound,
    },
  ],
  "unflagged-app": [
    {
      describe: "the config sets none of the options its code argues for",
      holds: setsNoneOfTheOptions,
    },
    {
      describe:
        "cacheComponents is on, so the plain server fetch is the cache directive's to carry",
      holds: cacheComponentsEnabled,
    },
    {
      describe: "no image convention anywhere, the only project in the corpus without one",
      holds: hasNoImageConvention,
    },
    {
      describe: "one manifest icon served from public/ and one provided by nothing",
      holds: hasOneServedIconAndOneMissing,
    },
  ],
  "overconfigured-app": [
    {
      describe: "the config names every unexamined option that is a writable key",
      holds: setsEveryReadableOption,
    },
    {
      describe:
        "cacheComponents is unset, so the plain server fetch is the extended fetch's to carry",
      holds: (root) => !cacheComponentsEnabled(root),
    },
    {
      describe: "the config names no page whose name is not a writable key, under any spelling",
      holds: namesNoUndetectablePage,
    },
  ],
  "handler-cache-app": [
    {
      describe: "a custom cache handler is configured, which is half of the pair this carries",
      holds: (root) => writes(root, "cacheHandler"),
    },
    {
      describe: "no cacheMaxMemorySize in any value, which is the other half",
      holds: (root) => !writes(root, "cacheMaxMemorySize"),
    },
    {
      // The two keys differ by one character and mean opposite things for the condition this
      // fixture carries, so holding both would leave it unsaid which one was read.
      describe: "no cacheHandlers, so the plural cannot be mistaken for the key this reads",
      holds: (root) => !writes(root, "cacheHandlers"),
    },
  ],
};
