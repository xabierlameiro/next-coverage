import { existsSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { readFlag, readFlagKeys, readFlagList, readFlagPresence } from "../collect/config.js";
import { proxyFiles } from "../collect/conventions.js";
import {
  readCacheProfiles,
  readHtmlLimitedBots,
  readOptimizedImports,
  readServerExternals,
  readWebVitals,
} from "../collect/defaults.js";
import type { SurfaceEntry } from "../collect/docs.js";
import { reaching } from "../collect/graph.js";
import { attributeLiteral, isInternalPath } from "../collect/jsx.js";
import { isReexportOnly, readDependencyManifest, resolveDependency } from "../collect/packages.js";
import type { Bundler } from "../collect/project.js";
import {
  callsResolvedTo,
  filesImportingModule,
  hasDirective,
  productionFiles,
  type SourceFileRecord,
  unversionedDirectories,
} from "../collect/sources.js";
import type { Resolved } from "../types.js";
import { runsOnTheServer } from "./functions.js";
import type {
  PredicateContext,
  PredicateSet,
  Suggestion,
  SuggestionPredicate,
  Verdict,
} from "./types.js";
import { match, NO_MATCH, suggest } from "./types.js";

/**
 * Whether the configuration sets an option, under any of the paths it has been documented at.
 * An option promoted out of `experimental` keeps working under the old key, so a project that
 * has not renamed it is using the feature and must not be told to adopt it.
 *
 * Unresolved counts as not set for the used verdict, and the caller must not read that as
 * absent — the suggestion side checks resolution separately.
 */
function isEnabled(context: PredicateContext, paths: readonly string[]): boolean {
  return paths.some((path) => {
    const value = readFlag(context.project.config, path);
    return value.status === "resolved" && value.value === true;
  });
}

/** True only when every path was read and none of them carried a value. */
function isDefinitelyUnset(context: PredicateContext, paths: readonly string[]): boolean {
  return paths.every((path) => {
    const value = readFlag(context.project.config, path);
    return value.status === "resolved" && value.value === undefined;
  });
}

/** The file the documented TypeScript requirement is really about. */
function isTypeScriptProject(context: PredicateContext): boolean {
  return existsSync(join(context.project.root, "tsconfig.json"));
}

/** The development cache is experimental, and the page writes it under that container. */
const HMR_CACHE_PATHS = ["serverComponentsHmrCache", "experimental.serverComponentsHmrCache"];

/**
 * Production files outside the client closure that fetch with `cache: 'no-store'`.
 *
 * The closure is what makes this a server question: a fetch in a file reachable from `'use client'`
 * runs in the browser, where no cache of the framework's stands between it and the network.
 */
function filesFetchingUncached(context: PredicateContext): string[] {
  const onTheServer = runsOnTheServer(context);
  return productionFiles(context.sources)
    .filter(onTheServer)
    .filter((file) =>
      file.fetchCaches.some((value) => value !== "unresolved" && value.literal === "no-store"),
    )
    .map((file) => file.path);
}

/** The option deciding whether a URL keeps its trailing slash, in both spellings. */
const TRAILING_SLASH_PATHS = ["trailingSlash", "experimental.trailingSlash"] as const;

/**
 * Production files writing a literal `href` that names a path this project serves and ends in a
 * slash. Read off any element rather than off `Link` alone: a bare anchor is redirected exactly
 * as a `Link` is, because the redirect is a property of the URL and not of what renders it.
 *
 * A computed href stays unread. `attributeLiteral` returns nothing for an expression, and a URL
 * this tool assembled itself is not one the project wrote.
 */
function filesLinkingWithTrailingSlash(context: PredicateContext): string[] {
  return productionFiles(context.sources)
    .filter((file) =>
      file.jsxElements.some((element) => {
        const href = attributeLiteral(element, "href");
        return href !== undefined && isInternalPath(href) && href.length > 1 && href.endsWith("/");
      }),
    )
    .map((file) => file.path);
}

/** `typedRoutes` was promoted out of `experimental`; both spellings still mean it is on. */
const TYPED_ROUTES_PATHS = ["typedRoutes", "experimental.typedRoutes"] as const;

const REACT_COMPILER_PATHS = ["reactCompiler", "experimental.reactCompiler"] as const;

/** Both are read under either spelling, like every option promoted out of `experimental`. */
const AUTH_INTERRUPTS_PATHS = ["authInterrupts", "experimental.authInterrupts"];

const USE_OFFLINE_PATHS = ["useOffline", "experimental.useOffline"];

/** Both options were promoted out of `experimental`, and the old spelling still works. */
const OPTIMIZE_IMPORTS_PATHS = ["optimizePackageImports", "experimental.optimizePackageImports"];

/** Promoted out of `experimental`, like every option read under both spellings. */
const URL_IMPORTS_PATHS = ["urlImports", "experimental.urlImports"];

const MDX_RS_PATHS = ["mdxRs", "experimental.mdxRs"];

/**
 * The names the reopened bundler conditions read off the route tree. The convention walk pushes
 * every file it declines onto `RouteNode.colocated`, so these are readable without widening the
 * scan — and only beside a route, which the findings say rather than claiming the project holds
 * nothing elsewhere.
 */
const SASS_NAME = /\.(?:scss|sass)$/i;

/**
 * A stylesheet, by the name a route colocates or by the specifier a module imports. Read off the
 * importing file rather than resolved: matching specifier text across files would call two
 * `./styles.css` in different directories one stylesheet, and anchoring on the importer avoids
 * the question.
 */
const STYLESHEET_NAME = /\.(?:css|scss|sass)$/i;

/**
 * The atomic-CSS frameworks the `inlineCss` page names as the case its trade-off works for:
 * *This trade-off works for small CSS (atomic frameworks like Tailwind), but adds overhead for
 * larger bundles*. The list is the page's example plus its two nearest equivalents, and nothing
 * is inferred from a package's name.
 */
const ATOMIC_CSS = ["tailwindcss", "unocss", "@unocss/core", "windicss"];

/**
 * The compression middlewares a custom server reaches for. A short list of package names, the way
 * the MDX integration and the atomic CSS frameworks are: the entry's own refusal names the shape —
 * *the option is inert behind a custom server that already compresses* — and a package import is
 * how that shape shows in a source tree. Nothing is inferred from a package's name.
 */
const COMPRESSION_MIDDLEWARE = [
  "compression",
  "@fastify/compress",
  "koa-compress",
  "express-static-gzip",
];

/** A PostCSS configuration, in the extensions the scan already indexes. */
const POSTCSS_NAME = /^postcss\.config\.(?:js|mjs|cjs|ts)$/i;

/** How many paths a finding cites before the count carries the rest. */
const EVIDENCE_LIMIT = 5;

/**
 * The integration the `mdxRs` page names as what the option is for: *For experimental use with
 * `@next/mdx`*. The siblings `@mdx-js/loader` and `@mdx-js/react` arrive with it rather than
 * instead of it, and `next-mdx-remote` compiles MDX at run time through a pipeline this option
 * never touches.
 */
const MDX_INTEGRATION = "@next/mdx";

/** Files sitting beside a route whose name the pattern matches, as paths a finding can cite. */
function colocatedMatching(context: PredicateContext, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const node of context.tree.nodes) {
    for (const name of node.colocated) {
      if (pattern.test(name)) found.push(join(node.directory, name));
    }
  }
  return found.sort();
}

/**
 * The one thing a condition can say about an option whose objection is a measurement nobody here
 * can take: it is unset, and a script runs the bundler it configures, so the installed release's
 * default is what is in force. The wording is the point — the finding states the default rather
 * than claiming the project would be better off, because no evidence available says it would.
 */
function defaultInForce(context: PredicateContext, what: string, where: string): Suggestion {
  const configPath = context.project.config?.path;
  if (configPath === undefined) return NO_MATCH;
  if (!runsBundler(context, "turbopack")) return NO_MATCH;
  return suggest(
    [configPath],
    `a script runs Turbopack, and ${what} is at the installed release's default`,
    where,
  );
}

/**
 * A versioned module that is a custom server and compresses: it reaches for the framework's own
 * programmatic entry and for a compression middleware in the same file. Both halves are required,
 * because a file importing `compression` alone is a middleware chain rather than a server, and one
 * importing `next` alone is any module in the project.
 */
function compressingServerModules(context: PredicateContext): string[] {
  return productionFiles(context.sources)
    .filter((file) => {
      const specifiers = file.moduleReferences.map((reference) => reference.specifier);
      return (
        specifiers.includes("next") &&
        specifiers.some((specifier) => COMPRESSION_MIDDLEWARE.includes(specifier))
      );
    })
    .map((file) => file.path)
    .sort();
}

/**
 * A build identity that carries a number where a name was configured.
 *
 * The shape rather than the value, and the record says why that is inference rather than a reading:
 * a function returning a commit sha or, failing that, a timestamp writes the second where the first
 * was unavailable, and a long run of digits is what the second looks like. Nothing here evaluates
 * the function, so this cannot know it was the fallback — only that the identity is a number.
 */
const LOOKS_LIKE_A_FALLBACK = /\d{10,}/;

/** How many route handlers the tree holds, which is what a static export cannot serve. */
function routeHandlerCount(context: PredicateContext): number {
  let found = 0;
  for (const node of context.tree.nodes) {
    for (const convention of node.conventions) {
      if (convention.name === "route") found += 1;
    }
  }
  return found;
}

/** Every convention file the route tree found, which is the set of entries a route is reached from. */
function routeEntries(context: PredicateContext): ReadonlySet<string> {
  const entries = new Set<string>();
  for (const node of context.tree.nodes) {
    for (const convention of node.conventions) entries.add(convention.file);
  }
  return entries;
}

/** Production files whose own source imports a stylesheet, by the specifier they wrote. */
function filesImportingAStylesheet(context: PredicateContext): string[] {
  return productionFiles(context.sources)
    .filter((file) =>
      file.moduleReferences.some((reference) => STYLESHEET_NAME.test(reference.specifier)),
    )
    .map((file) => file.path)
    .sort();
}

/** Whether the project's manifest declares a package by name. */
function declaresPackage(context: PredicateContext, name: string): boolean {
  const declared = context.project.declaredPackages;
  return declared.status === "resolved" && declared.value.has(name);
}

/**
 * Whether any script the project writes runs this bundler.
 *
 * Unresolved is false, and deliberately: the reading is unresolved where the CLI's own flags could
 * not be read or where every invoking script picks a spelling the release does not declare, and a
 * gate that treated either as the default would be the reading this repository just removed.
 */
function runsBundler(context: PredicateContext, bundler: Bundler): boolean {
  const { bundlers } = context.project;
  return bundlers.status === "resolved" && bundlers.value.has(bundler);
}

/** Options read under both spellings, like every option promoted out of `experimental`. */
const SERVER_ACTIONS_PATHS = ["serverActions", "experimental.serverActions"];
const STALE_TIMES_PATHS = ["staleTimes", "experimental.staleTimes"];
const WEB_VITALS_PATHS = ["webVitalsAttribution", "experimental.webVitalsAttribution"];
/**
 * The two functions the taint flag admits, named as React exports them. The `experimental_` prefix
 * is part of the name rather than a marker on it, and the bundled page links both under it.
 */
const TAINT_APIS = ["experimental_taintObjectReference", "experimental_taintUniqueValue"] as const;

/**
 * Whether any production file reaches for a taint function, by import or by call. Both are read
 * because a project may pull the function off a namespace import, which leaves a call and no
 * binding to anchor on — and either says the flag is being used for what it admits.
 *
 * Tests are excluded, for the reason they are excluded everywhere else here: a test exercising an
 * API is not a project adopting it.
 */
function callsATaintApi(context: PredicateContext): boolean {
  return productionFiles(context.sources).some(
    (file) =>
      TAINT_APIS.some((api) =>
        (file.imports.get("react") ?? []).some(
          (binding) => binding.imported === api && !binding.typeOnly,
        ),
      ) || TAINT_APIS.some((api) => file.calledIdentifiers.has(api)),
  );
}

const TAINT_PATHS = ["taint", "experimental.taint"];
const CACHE_COMPONENTS_PATHS = ["cacheComponents", "experimental.cacheComponents"];
const VIEW_TRANSITION_PATHS = ["viewTransition", "experimental.viewTransition"];
const PARTIAL_PREFETCH_PATHS = ["partialPrefetching", "experimental.partialPrefetching"];
const RUST_COMPILER_PATHS = [
  "turbopackRustReactCompiler",
  "experimental.turbopackRustReactCompiler",
];

const SERVER_EXTERNAL_PATHS = [
  "serverExternalPackages",
  "experimental.serverComponentsExternalPackages",
];

/** The hooks the compiler exists to make unnecessary. */
const MEMO_HOOKS = ["useMemo", "useCallback"] as const;

/**
 * Route conventions present on disk and inert because their flag is off. The tree already records
 * this, and nothing has ever read it — a convention Next.js skips renders nothing, and the file
 * sitting there is the strongest argument for turning the option on that a project can make.
 */
function conventionsSkippedFor(context: PredicateContext, flag: string): string[] {
  const files: string[] = [];
  for (const node of context.tree.nodes) {
    for (const convention of node.conventions) {
      // The tree records the path the flag was found under, which may carry the experimental
      // prefix. Matching on the last segment keeps both spellings.
      const skipped = convention.skippedForFlag;
      if (skipped !== undefined && skipped.split(".").pop() === flag) files.push(convention.file);
    }
  }
  return files;
}

/** Production files importing a module, which is how an inert API announces itself. */
function productionImportersOf(context: PredicateContext, module: string): string[] {
  const importing = new Set(filesImportingModule(context.sources, module).map((f) => f.path));
  return productionFiles(context.sources)
    .filter((file) => importing.has(file.path))
    .map((file) => file.path);
}

/**
 * Cache scopes naming a `cacheLife` profile that nothing defines: not one of the built-ins Next.js
 * ships, and not one the configuration adds. Such a call silently falls back to the default
 * profile, so the scope is cached on terms nobody chose.
 *
 * The built-in names are read from the installed package rather than listed here, for the reason
 * every other list is: a release adding a profile would otherwise turn it into a finding.
 */
function scopesNamingAnUndefinedProfile(context: PredicateContext): {
  files: string[];
  profiles: string[];
} {
  const builtIn = readCacheProfiles(context.project.installedNext);
  if (builtIn.status !== "resolved") return { files: [], profiles: [] };

  const files: string[] = [];
  const profiles = new Set<string>();
  const cached = new Set(
    context.sources.files
      .filter((file) => CACHE_DIRECTIVES.some((directive) => hasDirective(file, directive)))
      .map((file) => file.path),
  );
  for (const file of productionFiles(context.sources)) {
    if (!cached.has(file.path)) continue;
    for (const call of file.calls) {
      if (call.callee !== "cacheLife") continue;
      const [first] = call.args;
      // An unread argument is not an undefined profile. A variable holding a profile name is
      // exactly the case where guessing would invent a finding.
      if (first === undefined || first === "unresolved") continue;
      const named = first.literal;
      if (builtIn.value.has(named)) continue;
      const configured = readFlag(context.project.config, `cacheLife.${named}`);
      if (configured.status !== "resolved" || configured.value !== undefined) continue;
      files.push(file.path);
      profiles.add(named);
    }
  }
  return { files, profiles: [...profiles] };
}

/**
 * Whether the option is written at all, under any of its spellings. An authored predicate
 * replaces the derived one for its entry, so it has to keep answering this: losing it would
 * report a project that sets the option as not using it, and then suggest it.
 */
function isConfigured(context: PredicateContext, paths: readonly string[]): boolean {
  return paths.some((path) => {
    const found = readFlagPresence(context.project.config, path);
    return found.status === "resolved" && found.value;
  });
}

/** Production files importing one of the memoization hooks, with the hook they import. */
function memoizingFiles(context: PredicateContext): string[] {
  const files = new Set<string>();
  for (const hook of MEMO_HOOKS) {
    for (const file of productionFiles(context.sources)) {
      const bindings = file.imports.get("react") ?? [];
      if (bindings.some((b) => b.imported === hook && !b.typeOnly)) files.add(file.path);
    }
  }
  return [...files];
}

/**
 * Production files importing from a URL. A specifier with an http scheme is not a package and not
 * a path: it resolves only when the option permitting it is on, so a file holding one is the
 * project's own argument for the option.
 */
function urlImportingFiles(context: PredicateContext): string[] {
  const files: string[] = [];
  for (const file of productionFiles(context.sources)) {
    const remote = file.moduleReferences.some(
      (reference) =>
        reference.specifier.startsWith("http://") || reference.specifier.startsWith("https://"),
    );
    if (remote) files.push(file.path);
  }
  return files;
}

/**
 * The packages that make a project a user of the ESLint integration. The page documents the
 * shipped config, not a `next.config` key, so the manifest is where adoption shows.
 */
const ESLINT_PACKAGES = ["eslint-config-next", "@next/eslint-plugin-next"] as const;

/**
 * The scope a cache directive names, where it names one. `'use cache'` alone opens the `default`
 * scope and names nothing, and `'use cache: private'` is the one scope the page says cannot be
 * configured — so neither reaches a handler slot a configuration could have filled.
 */
const NAMED_CACHE_SCOPE = /^use cache: (.+)$/;

/** Every directive a file carries, wherever it wrote it. */
function directivesOf(file: SourceFileRecord): readonly string[] {
  return [...file.fileDirectives, ...file.functionDirectives];
}

/**
 * Production files naming a cache scope the configuration declares no handler for, with the scope
 * names they wrote.
 *
 * Reads the configured keys rather than assuming the option is absent: an entry reporting as used
 * still carries its condition beside the verdict, so a project filling `default` and writing
 * `'use cache: remote'` is exactly the case this has to answer.
 *
 * Silent where the configuration could not be read. A key list nobody could read is not an empty
 * one, and treating it as empty would report every named scope in the project as unfilled.
 */
function scopesWithNoHandler(context: PredicateContext): {
  readonly files: readonly string[];
  readonly scopes: readonly string[];
} {
  const nothing = { files: [], scopes: [] };
  const present = readFlagPresence(context.project.config, "cacheHandlers");
  if (present.status !== "resolved") return nothing;

  let configured: ReadonlySet<string> = new Set();
  if (present.value) {
    const keys = readFlagKeys(context.project.config, "cacheHandlers");
    if (keys.status !== "resolved") return nothing;
    configured = new Set(keys.value);
  }

  const files: string[] = [];
  const scopes = new Set<string>();
  for (const file of productionFiles(context.sources)) {
    const unfilled = directivesOf(file)
      .flatMap((directive) => NAMED_CACHE_SCOPE.exec(directive)?.[1] ?? [])
      .filter((scope) => scope !== "private" && !configured.has(scope));
    if (unfilled.length === 0) continue;
    files.push(file.path);
    for (const scope of unfilled) scopes.add(scope);
  }
  return { files, scopes: [...scopes].sort() };
}

/** The `robots` metadata convention, where the tree found one the flags did not skip. */
function robotsConventionFile(context: PredicateContext): string | undefined {
  for (const node of context.tree.nodes) {
    for (const convention of node.conventions) {
      if (convention.name === "robots" && convention.skippedForFlag === undefined) {
        return convention.file;
      }
    }
  }
  return undefined;
}

/**
 * The wildcard names no crawler. A `robots` file addressing every agent has stated a rule about
 * all of them rather than singled one out, so there is no literal to compare and nothing to say.
 */
const EVERY_USER_AGENT = "*";

/**
 * The `react-dom` exports that make React emit a `Link` header, as the page names them. Read as
 * imports from `react-dom` rather than as bare names: `preload` and `preconnect` are words a
 * project may well have its own function for, and the import is what says which one was called.
 */
const RESOURCE_PRELOAD_APIS = [
  "preload",
  "preloadModule",
  "preconnect",
  "prefetchDNS",
  "preinit",
  "preinitModule",
] as const;

/** The names the framework's own proxy examples give the request, and the only ones read. */
const REQUEST_NAMES = new Set(["request", "req"]);

/** The proxy convention file this project has, where it has one. */
function proxyConventionFile(
  root: string,
  pageExtensions: Resolved<readonly string[]>,
): string | undefined {
  for (const segments of proxyFiles(pageExtensions)) {
    const path = join(root, ...segments);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * The production files the router reaches: everything under the app directory, and everything
 * those files import, transitively.
 *
 * The two package conditions need it because `productionFiles` is not the bundle. It excludes a
 * test by name, which leaves `playwright.config.ts` in — a file that imports a test runner, is
 * never bundled, and made the barrel condition name `@playwright/test` on every project it was
 * measured against. A finding about what a named import costs the bundle has to be read off code
 * the bundle holds.
 *
 * One walk over the whole app directory rather than one per convention file: the question is which
 * files are reached at all, and asking it once per route would answer it many times over.
 */
function filesTheRouterReaches(context: PredicateContext): ReadonlySet<string> {
  const app = `${context.project.appDirectory.path}${sep}`;
  const reached = new Set<string>();
  const queue = productionFiles(context.sources)
    .map((file) => file.path)
    .filter((path) => path.startsWith(app));
  for (const path of queue) reached.add(path);

  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index];
    if (path === undefined) continue;
    for (const next of context.graph.edges.get(path) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

/**
 * Package names a file imports through a bare specifier the resolver placed outside the project.
 * A relative path is this project's own code and a missing package is one it does not have.
 */
function externalPackagesOf(file: SourceFileRecord): readonly string[] {
  return file.moduleReferences
    .filter((reference) => reference.resolution.kind === "external" && !reference.typeOnly)
    .map((reference) => reference.specifier);
}

/**
 * The package a specifier names, with any subpath dropped: `lodash/fp` is `lodash`, and the
 * manifest that answers for it is the package's own.
 */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * Whether the installed release already handles an import, asked of the default list as the release
 * writes it.
 *
 * The specifier first, then the bare package name. A release lists what it handles the way it
 * handles it, and some of those entries are subpaths: 16.3.0 names `react-icons/si` and
 * `react-icons/fc` individually and never `react-icons`. Reducing an import to its package name
 * before asking therefore missed every package listed that way, and a project importing those two
 * subpaths was told to add `react-icons` to the option — which would have added nothing.
 *
 * Both readings are kept because both occur: the server-external list is bare today, and a release
 * that starts listing a package by subpath there is read correctly without a second change.
 */
export function alreadyHandles(
  handled: ReadonlySet<string>,
  specifier: string,
  name: string,
): boolean {
  return handled.has(specifier) || handled.has(name);
}

/**
 * Whether a package name is one this condition may speak about at all: declared by the project,
 * and named by neither the configuration nor the list the installed release already applies.
 *
 * The second half is what keeps these conditions clear of the constraint that ships for the same
 * options. That constraint reports the packages the framework already handles and leaves the entry
 * in *Used*; a package on the default list is its subject, and never one of these.
 */
function candidatePackages(
  context: PredicateContext,
  configuredPaths: readonly string[],
  alreadyHandled: Resolved<ReadonlySet<string>>,
): ((specifier: string, name: string) => boolean) | undefined {
  const declared = context.project.declaredPackages;
  if (declared.status !== "resolved" || alreadyHandled.status !== "resolved") return undefined;

  // A list with a skipped element was read in part. `optimizePackageImports: [...HEAVY, 'otro']`
  // resolves with one name and one element nobody could read, and treating that as the whole list
  // would report a package the project configured through the half that did not resolve — which is
  // the finding this tool does not make.
  const configured = new Set<string>();
  for (const path of configuredPaths) {
    // A branched list is taken as written, unlike a half-read one: this collects the packages the
    // config already handles so they are not suggested again, and one handled on either branch is
    // handled. `skipped` still refuses, because there the unread names are unknown rather than
    // conditional.
    const list = readFlagList(context.project.config, path);
    if (list.status !== "resolved" || list.value.skipped > 0) return undefined;
    for (const value of list.value.values) configured.add(value);
  }

  const handled = alreadyHandled.value;
  return (specifier, name) =>
    declared.value.has(name) && !configured.has(name) && !alreadyHandles(handled, specifier, name);
}

/**
 * Whether an installed dependency declares a native addon, read off its own `package.json`.
 *
 * `gypfile` is the package saying so about itself, which is why it is the reading rather than a
 * classification of what the package ships. A specifier that resolves nowhere, or a manifest that
 * will not open, answers `false`: a package this cannot read is one it says nothing about.
 */
function declaresNativeAddon(root: string, name: string): boolean {
  const directory = resolveDependency(root, name);
  if (directory.status !== "resolved") return false;
  const manifest = readDependencyManifest(directory.value);
  return manifest.status === "resolved" && manifest.value.gypfile;
}

/**
 * Whether an installed dependency's entry module is nothing but re-exports.
 *
 * Two files, both named by the dependency: the manifest, and the entry it points at. Declining at
 * either step answers `false`, so a package whose entry is a conditional map or will not parse is
 * left alone rather than guessed at.
 */
function entryIsReexportOnly(root: string, name: string): boolean {
  const directory = resolveDependency(root, name);
  if (directory.status !== "resolved") return false;
  const manifest = readDependencyManifest(directory.value);
  if (manifest.status !== "resolved") return false;
  const barrel = isReexportOnly(manifest.value.entry);
  return barrel.status === "resolved" && barrel.value;
}

export const CONFIG_PREDICATES: readonly PredicateSet[] = [
  {
    // Neither this nor the TypeScript page below documents a `next.config` key — the keys have
    // their own pages under `next-config-js`, which the derived predicate already covers. These
    // two document the integrations themselves, so adoption is a declared package and a tsconfig
    // rather than anything the configuration says.
    id: "config/eslint",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const declared = context.project.declaredPackages;
      if (declared.status !== "resolved") return NO_MATCH;
      const found = ESLINT_PACKAGES.filter((name) => declared.value.has(name));
      return found.length === 0 ? NO_MATCH : match([join(context.project.root, "package.json")]);
    },
    noSuggestion: {
      kind: "abstained",
      measuredAgainst: "16.3.0",
      why: "which linter a project runs is its own choice, not a gap in its Next.js adoption",
    },
  },
  {
    id: "config/typescript",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const tsconfig = join(context.project.root, "tsconfig.json");
      return existsSync(tsconfig) ? match([tsconfig]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "abstained",
      measuredAgainst: "16.3.0",
      why: "moving a project to TypeScript is a migration, not an API this tool suggests adopting",
    },
  },
  {
    id: "config/next-config-js/reactCompiler",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, REACT_COMPILER_PATHS) ? match([configPath]) : NO_MATCH;
    },
    wouldApply: (context): Suggestion => {
      if (!isDefinitelyUnset(context, REACT_COMPILER_PATHS)) return NO_MATCH;
      const files = memoizingFiles(context);
      // Factual, not diagnostic: whether a given memoization is redundant needs the compiler
      // itself, so the note reports what was seen and leaves the judgement to the reader.
      return files.length === 0
        ? NO_MATCH
        : suggest(
            files,
            "these files memoize by hand, and the compiler that would do it is off",
            "the compiler memoizes components and hooks at build time, so the hand-written useMemo and useCallback have nothing left to do",
          );
    },
  },
  {
    id: "config/next-config-js/typedRoutes",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isEnabled(context, TYPED_ROUTES_PATHS) ? match([configPath]) : NO_MATCH;
    },
    notApplicable: (context): Verdict =>
      isTypeScriptProject(context)
        ? NO_MATCH
        : match(
            [context.project.root],
            "the documentation requires TypeScript, and this project has no tsconfig.json",
          ),
    wouldApply: (context): Suggestion => {
      // Unresolved is not unset. An option nobody could look for is not one that is missing,
      // and suggesting it would be advice to adopt what the project may already have.
      if (!isDefinitelyUnset(context, TYPED_ROUTES_PATHS)) return NO_MATCH;
      const linking = new Set(
        filesImportingModule(context.sources, "next/link").map((file) => file.path),
      );
      const files = productionFiles(context.sources)
        .filter((file) => linking.has(file.path))
        .map((file) => file.path);
      return files.length === 0
        ? NO_MATCH
        : suggest(
            files,
            "these files link with unchecked hrefs, so a typo 404s instead of failing to build",
            "every href is checked against the route tree at build time, and the editor completes them",
          );
    },
  },
  {
    // The suggestion is to turn the option on, so it lives here and not on the convention: the
    // files are already written. And it must not be gated on the flag it argues about — a gate
    // would skip this entry in exactly the case it exists to report.
    id: "config/next-config-js/authInterrupts",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isEnabled(context, AUTH_INTERRUPTS_PATHS) ? match([configPath]) : NO_MATCH;
    },
    wouldApply: (context): Suggestion => {
      if (!isDefinitelyUnset(context, AUTH_INTERRUPTS_PATHS)) return NO_MATCH;
      const skipped = conventionsSkippedFor(context, "authInterrupts");
      return skipped.length === 0
        ? NO_MATCH
        : suggest(
            skipped,
            "these conventions are written and never render, because the flag is off",
            "with the flag on, forbidden and unauthorized interrupt the render and mount these files",
          );
    },
  },
  {
    id: "config/next-config-js/useOffline",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isEnabled(context, USE_OFFLINE_PATHS) ? match([configPath]) : NO_MATCH;
    },
    wouldApply: (context): Suggestion => {
      if (!isDefinitelyUnset(context, USE_OFFLINE_PATHS)) return NO_MATCH;
      const importers = productionImportersOf(context, "next/offline");
      return importers.length === 0
        ? NO_MATCH
        : suggest(
            importers,
            "these import the hook, which returns false while the flag is off",
            "with the flag on, the hook reports the connection state the browser sees",
          );
    },
  },
  {
    id: "config/next-config-js/cacheLife",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["cacheLife", "experimental.cacheLife"])
        ? match([configPath])
        : NO_MATCH;
    },
    wouldApply: (context): Suggestion => {
      const { files, profiles } = scopesNamingAnUndefinedProfile(context);
      return files.length === 0
        ? NO_MATCH
        : suggest(
            files,
            `these name ${profiles.join(", ")}, which nothing defines, so the scope falls back to the default profile`,
            "a profile defined under this option gives the scope the lifetime the name was written for",
          );
    },
  },
  {
    // Authored to take this id off the derived predicate, whose reason — that nothing in a
    // codebase argues for setting an option — is not the one this option was closed for. What
    // it was closed for is now answerable: the packages Next.js already optimizes ship inside
    // the installed package, and a declaration overlapping them is reported as a constraint.
    id: "config/next-config-js/optimizePackageImports",
    cost: "FS",
    // Resolving a bare specifier and parsing a module that is not the one under analysis is not a
    // single-file read, whatever it costs. Declared on the condition alone: the used detection is
    // one look at the configuration.
    conditionCost: "GRAFO",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, OPTIMIZE_IMPORTS_PATHS) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a package worth optimizing that the configuration does not name",
      outcome:
        "which packages to optimize is answered by the default list Next.js applies, and what a " +
        "project adds beyond it is a bundling decision reported as a constraint",
    },
    // The refusal read the manifest, which carries a name and nothing else. The installed package
    // carries the shape the page describes: it names a package exporting hundreds or thousands of
    // modules, and an entry module that is nothing but re-exports is that shape in one parse. How
    // many it reaches is not claimed — counting them means opening every module it names.
    //
    // Filtered by the same default list the shipping constraint compares against, so a package
    // the framework already optimizes is that constraint's subject and never this one's.
    wouldApplyStrict: (context): Suggestion => {
      const candidate = candidatePackages(
        context,
        OPTIMIZE_IMPORTS_PATHS,
        readOptimizedImports(context.project.installedNext),
      );
      if (candidate === undefined) return NO_MATCH;

      const { root } = context.project;
      const bundled = filesTheRouterReaches(context);
      const barrels = new Set<string>();
      const files = new Set<string>();
      for (const file of productionFiles(context.sources)) {
        if (!bundled.has(file.path)) continue;
        // Only the specifiers the resolver placed outside the project. A bare specifier is not a
        // package name on its own: a project mapping `baseUrl` onto its own source imports
        // `config` and means its own module, and a dependency of that name in the manifest would
        // make the pair look like an import of the package.
        const external = new Set(externalPackagesOf(file));
        for (const [specifier, bindings] of file.imports) {
          if (!external.has(specifier)) continue;
          // Named bindings only. A default import takes one thing from the module whatever else
          // it re-exports, and the option's whole subject is what a named import pulls in beside
          // what it asked for.
          if (
            !bindings.some((b) => !b.typeOnly && b.imported !== "default" && b.imported !== "*")
          ) {
            continue;
          }
          const name = packageNameOf(specifier);
          if (!candidate(specifier, name)) continue;
          if (!barrels.has(name) && !entryIsReexportOnly(root, name)) continue;
          barrels.add(name);
          files.add(file.path);
        }
      }
      return barrels.size === 0
        ? NO_MATCH
        : suggest(
            [...files].sort(),
            `these import named bindings from ${[...barrels].sort().join(", ")}, whose installed entry module is a re-export barrel`,
            "the option makes the bundler take only the modules a named import reaches, which its page says is what a package exporting hundreds of them costs without it",
          );
    },
  },
  {
    id: "config/next-config-js/serverExternalPackages",
    cost: "FS",
    // Same reading as the entry above, and the same reason it is declared apart from the used
    // detection: one look at the configuration decides the bucket, and this decides nothing.
    conditionCost: "GRAFO",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, SERVER_EXTERNAL_PATHS) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a declared dependency carrying a native binary, absent from the option",
      outcome:
        "the framework ships a default external list, so a package the condition would name " +
        "is either already on it — where the suggestion restates what the framework does — or " +
        "absent from it for a reason a manifest entry does not carry",
    },
    // The refusal's second half is the one this answers: a manifest entry does not carry whether a
    // package uses Node-specific features, and the installed package does. `gypfile` is the
    // package declaring a node-gyp build about itself, which is a native addon by construction and
    // not a classification made here.
    //
    // Read off files outside the client closure, because the option governs what the server
    // bundle externalises and a module that runs in the browser is not what it is about.
    wouldApplyStrict: (context): Suggestion => {
      const candidate = candidatePackages(
        context,
        SERVER_EXTERNAL_PATHS,
        readServerExternals(context.project.installedNext),
      );
      if (candidate === undefined) return NO_MATCH;

      const { root } = context.project;
      const bundled = filesTheRouterReaches(context);
      const native = new Set<string>();
      const files = new Set<string>();
      for (const file of productionFiles(context.sources)) {
        if (!bundled.has(file.path) || context.graph.clientClosure.has(file.path)) continue;
        for (const specifier of externalPackagesOf(file)) {
          const name = packageNameOf(specifier);
          if (!candidate(specifier, name)) continue;
          if (!native.has(name) && !declaresNativeAddon(root, name)) continue;
          native.add(name);
          files.add(file.path);
        }
      }
      return native.size === 0
        ? NO_MATCH
        : suggest(
            [...files].sort(),
            `these reach ${[...native].sort().join(", ")} from the server, and each installed package declares a native addon`,
            "the option leaves the package to Node's own require instead of bundling it, which its page says is what a dependency using Node-specific features needs",
          );
    },
  },
  {
    id: "config/next-config-js/images",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["images"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a literal remote image host in the source that no remotePattern covers",
      outcome:
        "the option governs the sources the image component optimises, so a literal remote " +
        "host argues for it only where that component is adopted — and an adopted component " +
        "receives its source as a prop, which is a value from another file rather than a " +
        "literal here",
    },
  },
  {
    id: "config/next-config-js/transpilePackages",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["transpilePackages"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a declared dependency publishing untranspiled source, absent from the option",
      outcome:
        "how a package publishes its own source is not something this tool derives, so what " +
        "Next.js already transpiles is read and reported as a constraint instead",
    },
  },
  {
    // The inert-code constraint next door answers for options that are flags: a convention file
    // present and skipped because its flag is off. This option is a list of extensions, so the
    // same shape does not reach it, and the condition it suggests is its own.
    id: "config/next-config-js/pageExtensions",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["pageExtensions"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition:
        "an App Router convention file whose extension pageExtensions does not cover, which " +
        "the framework therefore never renders",
      outcome:
        "an unrecognised extension is exactly where a data file and a miswritten convention " +
        "look alike: a file named for a convention in an extension the framework does not " +
        "render may be content that borrowed the name, and nothing in the file separates the " +
        "two",
    },
  },
  {
    id: "config/next-config-js/env",
    cost: "FS",
    // The condition asks which modules the client closure holds, which is a question about how the
    // files reference each other rather than about any one of them. `detectUsed` reads the config
    // file alone, and used to be declared `GRAFO` because there was nowhere else to say this.
    conditionCost: "GRAFO",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["env"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a key the option injects into the bundle that no source file reads",
      outcome:
        "a key the option injects that no source reads is a value the project already " +
        "configured, and a configured value nothing uses is reported as a constraint on the " +
        "option rather than suggested — the channel every restated or unused one goes through",
    },
    // The refusal read the option against nothing reading the key. Its page states something
    // sharper: a key set here is *always* included in the JavaScript bundle, and `NEXT_PUBLIC_`
    // has no effect on that — the option decides it. So a key only server modules read is in the
    // browser bundle all the same, which is a fact about the project rather than a value unused.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      const keys = readFlagKeys(context.project.config, "env");
      if (keys.status !== "resolved" || keys.value.length === 0) return NO_MATCH;

      // Read directly, or not read as far as this can tell. A project that validates its
      // environment into an exported object — `env.KEY` rather than `process.env.KEY` — hides
      // every read behind one module, and a key nobody appears to read there may be read
      // everywhere. So a key is only judged where the project reads it directly somewhere: that
      // read is what says the pattern is the one this can follow.
      const onTheClient = context.graph.clientClosure;
      const readInBrowser = new Set<string>();
      const readAnywhere = new Set<string>();
      for (const file of productionFiles(context.sources)) {
        for (const key of file.environmentReads) {
          readAnywhere.add(key);
          if (onTheClient.has(file.path)) readInBrowser.add(key);
        }
      }

      const serverOnly = keys.value
        .filter((key) => readAnywhere.has(key) && !readInBrowser.has(key))
        .sort();
      return serverOnly.length === 0
        ? NO_MATCH
        : suggest(
            [configPath],
            `these keys are read only by server modules and are in the browser bundle anyway: ${serverOnly.join(", ")}`,
            "a key the option carries is inlined into the bundle whatever reads it, and its page says the NEXT_PUBLIC_ prefix does not decide that here — an env file or the environment keeps a server-only value off the client",
          );
    },
  },
  {
    id: "config/next-config-js/output",
    cost: "FS",
    // The condition reads the build and says so here, beside the reading rather than on the entry.
    // Declaring it on the set would gate the whole entry: a project whose build is stale would stop
    // being told this option is configured, trading a verdict the tool has for a condition that
    // reports nothing.
    conditionCost: "BUILD",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["output"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition:
        "the option set to 'export' beside code a static export does not support, which the " +
        "documentation lists",
      outcome:
        "a static export beside code it does not support is a build the framework refuses, so " +
        "the finding would duplicate an error the export itself gives — and with the option " +
        "unset there is nothing to read, because whether a project wants a static export is " +
        "not a property of its source",
    },
    // The refusal's second half is the one this answers: there is something to read, and it is not
    // in the source. Where every route the build's own mapping lists was prerendered and the tree
    // holds no route handler, the build the project already produced is route for route what a
    // static export produces. A route recorded as partially static satisfies neither side and is
    // not collapsed into one.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      if (context.build.status !== "resolved") return NO_MATCH;
      const build = context.build.value;
      if (build.routeUrls.size === 0) return NO_MATCH;
      if (routeHandlerCount(context) > 0) return NO_MATCH;
      const notStatic = [...build.routeUrls.values()].filter(
        (url) => build.prerendered.get(url)?.mode !== "STATIC",
      );
      return notStatic.length > 0
        ? NO_MATCH
        : suggest(
            [configPath],
            `all ${build.routeUrls.size} routes the build recorded were prerendered, and the tree holds no route handler`,
            "the option's export value writes that build to disk with no server, which is what this build already is route for route",
          );
    },
  },
  {
    // The one option in this group whose forward reading is provable: an http specifier is not
    // a package and not a path, so a file holding one resolves nowhere until the option is on.
    // That is the project's own argument, already written into its imports.
    id: "config/next-config-js/urlImports",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, URL_IMPORTS_PATHS) ? match([configPath]) : NO_MATCH;
    },
    wouldApply: (context): Suggestion => {
      const importing = urlImportingFiles(context);
      return importing.length === 0
        ? NO_MATCH
        : suggest(
            importing,
            "these files import from a URL, which resolves only with this option on",
            "with the option on, the URL resolves at build time and the module is fetched once and locked in the lockfile",
          );
    },
  },
  {
    id: "config/next-config-js/sassOptions",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["sassOptions"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a stylesheet written in Sass, which is what makes the option mean anything",
      outcome:
        "the source scan indexes .ts, .tsx, .js, .jsx, .mjs and .cjs, so a .scss file is not " +
        "a fact this tool holds — refused for the missing input rather than measured against " +
        "it",
    },
    // The input the refusal called missing is one the tree has always held: the convention walk
    // pushes every file it declines onto `colocated`, names included. So the reading costs nothing
    // and reaches only what sits beside a route — a project keeping its Sass in `styles/` is
    // invisible here, which produces silence rather than a claim.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      const found = colocatedMatching(context, SASS_NAME);
      return found.length === 0
        ? NO_MATCH
        : suggest(
            found.slice(0, EVIDENCE_LIMIT),
            `${found.length} Sass ${found.length === 1 ? "file sits" : "files sit"} beside a route`,
            "the option is where the Sass compiler's own settings go — the implementation to run it with, or data prepended to every file — and the project compiles Sass with whatever the framework picks",
          );
    },
  },
  {
    id: "config/next-config-js/mdxRs",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, MDX_RS_PATHS) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "MDX content compiled by the JavaScript pipeline rather than the Rust one",
      outcome:
        "which compiler builds the same MDX is a performance choice with the same output, so " +
        "neither direction argues anything a project has to act on — and .mdx is outside the " +
        "extensions the scan indexes in any case",
    },
    // The integration the page names, and nothing else. An `.mdx` file beside a route was the
    // other half of this condition, but a project can keep `.mdx` files it never compiles through
    // the framework — declaring `next-mdx-remote` instead, which builds MDX at run time. A file
    // says the project has MDX; only the integration says the framework compiles it, and this
    // option is about which compiler the framework uses.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      if (!runsBundler(context, "turbopack")) return NO_MATCH;
      if (!declaresPackage(context, MDX_INTEGRATION)) return NO_MATCH;
      return suggest(
        [configPath],
        `the manifest declares ${MDX_INTEGRATION}, which is what the page offers this option for`,
        "the option compiles the same MDX with the Rust compiler instead of the JavaScript one, which is the pipeline the rest of a Turbopack build already runs through",
      );
    },
  },
  {
    id: "config/next-config-js/webpack",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["webpack"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a webpack function the build never calls, because another bundler builds it",
      outcome:
        "which bundler runs is decided by a command-line flag, and a source tree does not say " +
        "how the project is built — so the condition would rest on an assumption about the " +
        "build command rather than on anything readable here",
    },
    // The refusal's obstacle was that the build command is not in the source tree. It is in the
    // manifest, and the reading is now settled against the flags the installed CLI declares. So
    // the mirror: a project running webpack that configured the other bundler and not this one.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      if (!runsBundler(context, "webpack")) return NO_MATCH;
      // Non-empty, because the refusal for the mirror entry recorded that an empty object quiets
      // a warning rather than configuring anything.
      const turbopack = readFlagKeys(context.project.config, "turbopack");
      if (turbopack.status !== "resolved" || turbopack.value.length === 0) return NO_MATCH;
      return suggest(
        [configPath],
        `a script runs webpack, and the configuration sets turbopack.${[...turbopack.value].sort().join(", turbopack.")}`,
        "this option is the same seam for the bundler that script runs — whatever the turbopack block arranges, webpack is arranged here",
      );
    },
  },
  {
    id: "config/next-config-js/turbopack",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["turbopack"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a bundler setting the project needs and has not written",
      outcome:
        "an empty object quiets a warning rather than configuring anything, and nothing in a " +
        "source tree argues for a bundler option — the same reason the group reason was true " +
        "of basePath",
    },
    // The mirror of the `webpack` entry, and the refusal shapes it rather than travelling beside
    // it: the test is a `webpack` value the project wrote, because a function a plugin wrapper
    // injects is not in the source the reader parses and this must not claim to have seen one.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      if (!runsBundler(context, "turbopack")) return NO_MATCH;
      const webpack = readFlagPresence(context.project.config, "webpack");
      if (webpack.status !== "resolved" || !webpack.value) return NO_MATCH;
      return suggest(
        [configPath],
        "a script runs Turbopack, and the configuration writes a webpack function",
        "this option is the same seam for the bundler that script runs — whatever the webpack function arranges, Turbopack is arranged here",
      );
    },
  },
  {
    // The rules themselves are the finding, and they are about a value the project configured,
    // so the entry sits in Used and the constraint channel carries what was found. Nothing here
    // suggests adopting the option: a project without redirects needs none.
    id: "config/next-config-js/redirects",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["redirects"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a rule routing a request away from a literal path the project also serves",
      outcome:
        "a rule routing a request away from a path the project also serves is reported as a " +
        "constraint on the configured option rather than as a suggestion, because a rule can " +
        "only exist where the option is already in use",
    },
  },
  {
    id: "config/next-config-js/rewrites",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["rewrites"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "the same rule, on the option that serves another path's response instead",
      outcome:
        "a rewrite pointing at a path nothing else serves is what a rewrite is for, and the " +
        "case where it does collide is checked by the same constraint as redirects rather " +
        "than suggested",
    },
  },
  {
    id: "config/next-config-js/headers",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["headers"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a rule taking a request away from a path the project serves",
      outcome:
        "this option takes nothing away: it adds headers to a response the route still " +
        "produces, so the condition its two siblings share does not apply to it, and which " +
        "headers a project ought to send is not readable from a source tree",
    },
  },
  {
    // The nested comparison answers for this one: the adoption fixture writes
    // `{ ignoreBuildErrors: false }`, which the framework already applies, and that is reported
    // as a constraint on this entry. The other direction — a project setting it to true, so type
    // errors stop stopping the build — is a decision the project made, and naming it would be a
    // judgement about the code rather than a fact about the configuration.
    id: "config/next-config-js/typescript",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["typescript"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a key inside the option set to the value the framework already applies",
      outcome:
        "a key set to the value the framework already applies is reported through the " +
        "restated-default constraint, and turning the check off is a choice this tool does " +
        "not grade — which is the only other thing the option can say",
    },
    // The refusal is right that this tool does not grade the choice, and the condition does not:
    // it reports what the page states the framework does at that value — *it does not run
    // TypeScript and suppress errors, it bypasses the check entirely* — and leaves the reader to
    // decide, the way the taint finding reports a channel rather than a mistake.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      const ignoring = readFlag(context.project.config, "typescript.ignoreBuildErrors");
      if (ignoring.status !== "resolved" || ignoring.value !== true) return NO_MATCH;
      return suggest(
        [configPath],
        "ignoreBuildErrors is set, and its page says the build does not run the type check at all rather than running it and suppressing what it finds",
        "with the key unset the build runs the check, so a type error stops a release instead of reaching it",
      );
    },
  },
  {
    id: "config/next-config-js/serverActions",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, SERVER_ACTIONS_PATHS) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "an allowed origin or a body limit set to what the framework already applies",
      outcome:
        "the one project that sets it builds the value from a conditional expression, so there " +
        "is no literal to compare — and what a project should allow is a deployment fact no " +
        "source tree carries",
    },
  },
  {
    id: "config/next-config-js/staleTimes",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, STALE_TIMES_PATHS) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a client cache duration set to the one the framework already applies",
      outcome:
        "answered by the nested restated-default comparison, which reads this option's scalars; " +
        "the one project setting it writes 180 against a different default, so it is silent",
    },
  },
  {
    id: "config/next-config-js/logging",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["logging"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a logging key set to the value the framework already applies",
      outcome:
        "answered by the nested comparison too, and silent on both projects that set it; what a " +
        "project wants printed in development is a preference, not something its code argues for",
    },
  },
  {
    id: "config/next-config-js/webVitalsAttribution",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, WEB_VITALS_PATHS) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a metric named that the installed release no longer accepts, which is inert",
      outcome:
        "the installed config schema accepts CLS, FCP, FID, INP, LCP and TTFB — every metric " +
        "the framework documents — so a configured value the release no longer accepts cannot " +
        "be written against it",
    },
    // Decidable, and expected to stay silent: the accepted set is every metric the framework
    // documents, so a project writing one of them writes an accepted one. It reports where a
    // release drops a metric a project still names, which is the case the refusal could not find.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      const accepted = readWebVitals(context.project.installedNext);
      if (accepted.status !== "resolved") return NO_MATCH;
      // A branched list is taken as written: a metric named on either branch is a metric the
      // config asks for, and one this version does not accept is unaccepted under both.
      const configured = WEB_VITALS_PATHS.map((path) =>
        readFlagList(context.project.config, path),
      ).find((list) => list.status === "resolved" && list.value.values.length > 0);
      if (configured === undefined || configured.status !== "resolved") return NO_MATCH;
      const unaccepted = configured.value.values.filter((metric) => !accepted.value.has(metric));
      return unaccepted.length === 0
        ? NO_MATCH
        : suggest(
            [configPath],
            `these metrics are configured and the installed release does not accept them: ${unaccepted.sort().join(", ")}`,
            "a metric the release does not accept is inert, so the attribution it was set for is not collected",
          );
    },
  },
  {
    id: "config/next-config-js/taint",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, TAINT_PATHS) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "the flag on with neither taint function called anywhere in the project",
      outcome:
        "turning a flag on before writing the code that uses it is the order the work happens " +
        "in, so a finding on the gap between the two would name a sequence rather than a " +
        "problem",
    },
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined || !isEnabled(context, TAINT_PATHS)) return NO_MATCH;
      if (callsATaintApi(context)) return NO_MATCH;
      return suggest(
        [configPath],
        "the flag is on and neither taint function is called, so the app directory is on React's experimental channel for nothing",
        "the two taint functions stop a value reaching the client by accident, which is what the flag was turned on to allow",
      );
    },
  },
  {
    id: "config/next-config-js/cacheComponents",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, CACHE_COMPONENTS_PATHS) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "the flag on with no cache directive anywhere, so nothing it enables is used",
      outcome:
        "both projects that set it use it — one holds eleven cached files, the other five — and " +
        "the condition carries the same flaw as taint's, naming an order of work rather than a " +
        "consequence",
    },
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined || !isEnabled(context, CACHE_COMPONENTS_PATHS)) return NO_MATCH;
      const cached = productionFiles(context.sources).some((file) =>
        CACHE_DIRECTIVES.some((directive) => hasDirective(file, directive)),
      );
      return cached
        ? NO_MATCH
        : suggest(
            [configPath],
            "the flag is on and no file carries a cache directive, so nothing it enables is used",
            "the directive is what the flag exists to admit: it caches a function's result, with cacheLife and cacheTag to set how long that lasts and to drop it",
          );
    },
  },
  {
    id: "config/next-config-js/viewTransition",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, VIEW_TRANSITION_PATHS) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "the flag on with the component it enables imported nowhere",
      outcome:
        "the flag and the code that uses it are written in that order, so a finding on the " +
        "gap between them names a sequence rather than a problem — the flaw taint's and " +
        "cacheComponents' conditions carry, and this is the third of the three",
    },
  },
  {
    id: "config/next-config-js/poweredByHeader",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["poweredByHeader"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "the option set to the value the framework already applies",
      outcome:
        "the scalar comparison already answers this, and the one project setting it writes false " +
        "against a default of true; whether to send the header is not something code argues for",
    },
  },
  {
    id: "config/next-config-js/reactStrictMode",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["reactStrictMode"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "the option set to the value the framework already applies",
      outcome:
        "the scalar comparison answers it, and is silent: the default is null and the one " +
        "project setting it writes true, which is a different value and a deliberate one",
    },
  },
  {
    id: "config/next-config-js/generateBuildId",
    cost: "FS",
    // A project can configure this option while its build is stale, so declaring `BUILD` on the
    // set moves it out of *Used* — otherwise the one case the tool could say something true about
    // would be reported against an artifact that no longer matches the config. Declared here, it
    // costs nothing.
    conditionCost: "BUILD",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["generateBuildId"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "the function returning something a deployment could not use as an identity",
      outcome:
        "the one project that sets it returns a commit sha falling back to a timestamp, and what " +
        "makes a build id correct is a property of the deployment rather than of the source",
    },
    // The family's weakest condition, written because the decision was to write it and recorded as
    // weak rather than mitigated. It infers which branch of somebody's function ran from the shape
    // of a string, which is inference about code this never evaluated; and the objection is
    // untouched by the evidence, because a timestamp is a correct identity for a deployment that
    // builds once. It is expected to stay behind `--strict` permanently.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      if (context.build.status !== "resolved") return NO_MATCH;
      if (!isConfigured(context, ["generateBuildId"])) return NO_MATCH;
      const { buildId } = context.build.value;
      if (!LOOKS_LIKE_A_FALLBACK.test(buildId)) return NO_MATCH;
      return suggest(
        [configPath],
        `the build recorded ${buildId}, which carries a number where an identity was configured`,
        "the option is where a build's identity comes from, and this build took a shape a function falls back to rather than one a deployment names",
      );
    },
  },
  {
    id: "config/next-config-js/partialPrefetching",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, PARTIAL_PREFETCH_PATHS) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "the flag on with nothing in the code that depends on it",
      outcome:
        "it changes what the framework prefetches and exposes no API a project calls, so there " +
        "is no use of it to look for and nothing in a source tree that could argue either way",
    },
    // The refusal is right that the source tree says nothing. The page says something the config
    // can be read against instead: without `cacheComponents`, `next dev` and `next build` throw at
    // config validation. That is a state of one file, not an order of work in a source tree.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined || !isEnabled(context, PARTIAL_PREFETCH_PATHS)) return NO_MATCH;
      // Unresolved is not absent: a config this reader could not evaluate says nothing either way.
      if (!isDefinitelyUnset(context, CACHE_COMPONENTS_PATHS)) return NO_MATCH;
      return suggest(
        [configPath],
        "this option is set and cacheComponents is not, which its page says makes next dev and next build throw at config validation",
        "with cacheComponents enabled the option takes effect instead of stopping the build, which is what setting it was for",
      );
    },
  },
  {
    id: "config/next-config-js/turbopackRustReactCompiler",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, RUST_COMPILER_PATHS) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "the same, on the option choosing which implementation compiles the same code",
      outcome:
        "no user-facing API either, and the same output whichever implementation runs — the " +
        "shape mdxRs was refused for",
    },
    // Two prerequisites its page states, and both are readable without the source tree: it selects
    // an implementation rather than turning the compiler on, and it throws under webpack.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined || !isEnabled(context, RUST_COMPILER_PATHS)) return NO_MATCH;
      // Webpack alone, not webpack among others. A project whose scripts run both has a build the
      // option works under, and the page's *throws with webpack* is about the build that runs it —
      // which the bundler set cannot say, because it does not record which script carried which.
      const bundlers = context.project.bundlers;
      const onlyWebpack =
        bundlers.status === "resolved" &&
        bundlers.value.has("webpack") &&
        !bundlers.value.has("turbopack");
      if (onlyWebpack) {
        return suggest(
          [configPath],
          "this option is set and every build script runs webpack, which its page says throws",
          "the option is supported only with Turbopack, so a build that runs webpack needs it unset",
        );
      }
      if (!isDefinitelyUnset(context, REACT_COMPILER_PATHS)) return NO_MATCH;
      return suggest(
        [configPath],
        "this option is set and reactCompiler is not, so it selects an implementation for a compiler nothing turned on",
        "the option chooses which implementation compiles the code and does not enable the compiler itself, which reactCompiler is what does",
      );
    },
  },
  {
    // The first forward reading this project writes rather than refuses. What makes it different
    // is that it does not argue the option would be reasonable: the project wrote a URL, and the
    // default rewrites that URL on every navigation. The evidence is the value, not the taste.
    id: "config/next-config-js/trailingSlash",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, TRAILING_SLASH_PATHS) ? match([configPath]) : NO_MATCH;
    },
    wouldApply: (context): Suggestion => {
      // Set either way is a decision already made. Only the unset case is one nobody chose.
      if (!isDefinitelyUnset(context, TRAILING_SLASH_PATHS)) return NO_MATCH;
      const files = filesLinkingWithTrailingSlash(context);
      return files.length === 0
        ? NO_MATCH
        : suggest(
            files,
            "these link to paths ending in a slash, which the default redirects on every " +
              "navigation",
            "with the option on, those paths are served as written, with no redirect on the way",
          );
    },
  },
  {
    id: "config/next-config-js/compress",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["compress"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a project serving its own responses with compression left off",
      outcome:
        "which server runs is not in the source tree, and the option is inert behind a custom " +
        "server that already compresses",
    },
    // The refusal's second half names a shape, and where a project versions the server the first
    // half says is absent, the shape is visible. The finding reports the arrangement rather than
    // an adoption: the page states that where compression is already configured through a custom
    // server the framework does not add its own, so this names what is in force and leaves the
    // reader to decide, which is the only thing the evidence supports.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      const servers = compressingServerModules(context);
      return servers.length === 0
        ? NO_MATCH
        : suggest(
            servers.slice(0, EVIDENCE_LIMIT),
            `${servers.length === 1 ? "a versioned module runs" : `${servers.length} versioned modules run`} the framework behind a compression middleware`,
            "the option is at its default and inert in that arrangement — the page says the framework adds no compression of its own where a custom server already has it, and names setting the option to false as how a project hands compression to its own server",
          );
    },
  },
  {
    id: "config/next-config-js/generateEtags",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["generateEtags"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a caching strategy the ETag defeats",
      outcome:
        "the strategy lives in a CDN or a proxy, and nothing in a source tree states what it is",
    },
  },
  {
    // The scan boundary is derived from what the project does not version, so a custom build
    // directory is one the boundary already excludes by name. The option is invisible to the
    // scan by construction rather than by omission, which is a stronger refusal than taste.
    id: "config/next-config-js/distDir",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["distDir"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a build directory the project uses under another name",
      outcome:
        "the name shows only in files the project does not version, which is exactly what the " +
        "scan boundary excludes",
    },
    // The one row in this family whose evidence contradicts its objection rather than illustrating
    // it. The name does show in a file the project versions: the ignore file, which is where the
    // scan boundary is derived from. A project that renamed its build directory and left the old
    // name in `.gitignore` is versioning its build output, and that is a consequence rather than
    // an edit somebody forgot to make.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      const value = readFlag(context.project.config, "distDir");
      if (value.status !== "resolved" || typeof value.value !== "string") return NO_MATCH;
      const configured = value.value;
      if (configured === "" || configured === ".next") return NO_MATCH;
      const ignored = unversionedDirectories(context.project.root);
      if (!ignored.has(".next") || ignored.has(configured)) return NO_MATCH;
      return suggest(
        [configPath, join(context.project.root, ".gitignore")],
        `the build is written to ${configured}, and .gitignore excludes .next and not ${configured}`,
        "the build output is not excluded from version control, which the ignore file says about the directory the project stopped using",
      );
    },
  },
  {
    id: "config/next-config-js/expireTime",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["expireTime"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      // Reopened against the page, which gives the arithmetic a condition could rest on: a path
      // revalidating every fifteen minutes under a one-hour expire time is served
      // `s-maxage=900, stale-while-revalidate=2700`. The reopening closed on the other half of
      // that pair. The installed release writes the default as a ternary on an environment
      // variable rather than a literal, so the scalar reader returns nothing, and a finding
      // naming a segment's `revalidate` beside an expire time nobody could read would state one
      // number and invent the other.
      condition:
        "a route segment exporting a finite revalidate with the option unset, named beside the " +
        "expire time the installed default applies to it",
      outcome:
        "the installed release writes the default as a ternary on an environment variable rather " +
        "than as a literal, so there is no expire time to name — and how long a CDN may hold a " +
        "stale response is a deployment fact a source tree states nothing about either",
    },
  },
  {
    // The weakest condition this family carries, and named as such where it is argued. Its page
    // names a reverse proxy that truncates long headers, and a repository holds no reverse proxy.
    // What it holds is the code that makes React emit the header at all, so the condition counts
    // those calls — a project that emits preload headers, not one whose headers are too long.
    // That is the recorded objection with a call count attached, and it is the entry to retire
    // first if this preset is trimmed.
    id: "config/next-config-js/reactMaxHeadersLength",
    cost: "FS",
    conditionCost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["reactMaxHeadersLength"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "prerendered headers longer than the default allows",
      outcome:
        "header length is produced by the build, and the source cannot say how long the emitted " +
        "headers are",
    },
    wouldApplyStrict: (context): Suggestion => {
      if (!isDefinitelyUnset(context, ["reactMaxHeadersLength"])) return NO_MATCH;
      const files = new Set<string>();
      const called = new Set<string>();
      for (const api of RESOURCE_PRELOAD_APIS) {
        for (const { file } of callsResolvedTo(context.sources, "react-dom", api)) {
          if (file.isTest) continue;
          files.add(file.path);
          called.add(api);
        }
      }
      return files.size === 0
        ? NO_MATCH
        : suggest(
            [...files].sort(),
            `these call ${[...called].sort().join(", ")}, which React emits as a Link header`,
            "the option sets the length that header is capped at, which its page says a reverse proxy in front of the server may truncate below",
          );
    },
  },

  {
    // The option carries a constraint rather than a suggestion: what it means for the code is
    // what the documentation asks the project to write once the option is set, and that is only
    // a question for a project that set it. Built in `collect/constraints.ts`.
    id: "config/next-config-js/basePath",
    cost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["basePath"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a codebase that argues for serving the application under a path prefix",
      outcome:
        "nothing in a source tree asks to be served from a subpath — the finding is on the " +
        "instruction the option's own page gives once it is set, reported as a constraint",
    },
  },
  {
    id: "config/next-config-js/assetPrefix",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["assetPrefix"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "an asset in the public folder referenced without the prefix the page says to add",
      outcome:
        "the page states that instruction as something to do if the project wants those files on " +
        "a CDN, and whether it wants that is not readable from source",
    },
  },
  {
    id: "config/next-config-js/deploymentId",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["deploymentId"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a project reading the query parameter the option appends to asset requests",
      outcome:
        "the page states the framework does not read it either, so a project handling it " +
        "contradicts nothing",
    },
  },
  {
    id: "config/next-config-js/outputHashSalt",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["outputHashSalt"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a build whose asset hashes the project needs changed",
      outcome:
        "the salt exists to change hashes without changing sources, so by construction no source " +
        "fact can argue for it",
    },
  },
  {
    id: "config/next-config-js/crossOrigin",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["crossOrigin"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a script element that would not receive the attribute the option sets",
      outcome:
        "the option is documented as acting on what next/script generates, and a script tag the " +
        "project wrote by hand is not something it ever claimed to reach",
    },
  },

  {
    // The finding is a constraint: the entries are modules the framework imports, so what they
    // mean for the code is only a question once the option names some. Built in
    // `collect/constraints.ts`, which is where the file system is read.
    id: "config/next-config-js/instrumentationClientInject",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["instrumentationClientInject"])
        ? match([configPath])
        : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a client module the project loads for its side effects before hydration",
      outcome:
        "which modules those are is a decision about what to load, not a fact a source tree " +
        "argues for — the finding is on the entries a configured list names and the project does " +
        "not hold, reported as a constraint",
    },
  },
  {
    id: "config/next-config-js/adapterPath",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["adapterPath"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "an adapter module the configuration names and the project does not contain",
      outcome:
        "the page writes the value as require.resolve('./my-adapter.js'), so there is no literal " +
        "to read — and that call already throws when the file is absent, which is the check this " +
        "condition would have duplicated",
    },
  },
  {
    /**
     * The page asks for one thing in as many words: *set this to `0` when adopting a custom
     * `cacheHandler`, so reads go to your store rather than a per-instance copy*. A project that
     * registers the handler and leaves the option alone keeps the documented 50 MB per instance,
     * and its reads no longer go there.
     *
     * The handler is read as `cacheHandler`, the key the framework accepts. The page is still
     * titled `incrementalCacheHandlerPath`, a name the key stopped using — `PAGE_KEYS` carries the
     * mapping and this reads through the same one.
     *
     * **`cacheHandlers`, the plural, is deliberately not read here.** Its own page says the handler
     * it registers manages its own memory and this option no longer applies to it, which is not a
     * request to set a value. The two keys differ by one character and mean opposite things for
     * this reading; a project registering the plural is one the documentation asks nothing of.
     *
     * The size is not read beyond `0`. The page names a default and no threshold, so a project
     * running 256 MB against a 50 MB default has made a call the source does not carry.
     */
    id: "config/next-config-js/cacheMaxMemorySize",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["cacheMaxMemorySize"]) ? match([configPath]) : NO_MATCH;
    },
    wouldApply: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      if (!isConfigured(context, ["cacheHandler"])) return NO_MATCH;
      // Zero is the state the page asks for, so a project already there is not told to go there.
      // Read as a value rather than as presence: an option set to 50 MB beside a handler is
      // exactly the case the page is written about, and presence alone would call it done.
      const size = readFlag(context.project.config, "cacheMaxMemorySize");
      if (size.status === "resolved" && size.value === 0) return NO_MATCH;
      return suggest(
        [configPath],
        "a custom cache handler is configured and this option is not 0, so each server instance still keeps the documented 50 MB copy",
        "at 0 the reads reach the handler's store instead of a per-instance copy of what it already holds",
      );
    },
  },
  {
    id: "config/next-config-js/cacheHandlers",
    cost: "FS",
    // The condition reads the directive at the top of a file, which the used detection never
    // opens: that reads the configuration alone. Declared here so the entry keeps the tier a
    // default run pays for.
    conditionCost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["cacheHandlers"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a handler module the configuration names and the project does not contain",
      outcome:
        "the same require.resolve call in every documented example, and the page states that " +
        "without the option the framework uses an in-memory LRU for both handlers, so nothing in " +
        "a source tree argues for setting it either",
    },
    // The refusal read the option forwards, and its page carries a topology instead: `default`
    // serves `'use cache'`, `remote` serves `'use cache: remote'`, a named handler serves
    // `'use cache: <name>'`. A file writing one of those named a slot. A configuration without
    // that key has not filled it, and the in-memory LRU is what serves the scope meanwhile.
    //
    // The flag is read here rather than declared on the set. Declaring it would withdraw the used
    // verdict from a project that configures the option without `cacheComponents`, trading a
    // reading the tool has for a condition it withholds.
    wouldApplyStrict: (context): Suggestion => {
      if (!isEnabled(context, CACHE_COMPONENTS_PATHS)) return NO_MATCH;
      const { files, scopes } = scopesWithNoHandler(context);
      return files.length === 0
        ? NO_MATCH
        : suggest(
            files,
            `these open the cache scope ${scopes.join(", ")}, which no handler is configured for`,
            "a handler under that key serves the scope; without one the framework's in-memory LRU does, which its page says is per process and lost on restart",
          );
    },
  },

  {
    // Grouped with the development-only options for where it runs, and it does not belong there:
    // what it acts on is production code, and the developer reading stale data is reading their
    // own project's fetches. Grouping by runtime is what nearly cost this one its examination.
    id: "config/next-config-js/serverComponentsHmrCache",
    cost: "AST",
    // The client closure removes browser-side fetches from what one read selected; nothing else.
    conditionCost: "GRAFO",
    conditionCostNarrows: true,
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, HMR_CACHE_PATHS) ? match([configPath]) : NO_MATCH;
    },
    wouldApply: (context): Suggestion => {
      // Set either way is a decision already made, and the default is no longer what they get.
      if (!isDefinitelyUnset(context, HMR_CACHE_PATHS)) return NO_MATCH;
      const files = filesFetchingUncached(context);
      return files.length === 0
        ? NO_MATCH
        : suggest(
            files,
            "these fetch with cache: 'no-store', which the development cache holds anyway, so " +
              "the data is not fresh between HMR refreshes",
            "with the option off, a no-store fetch is refetched on every HMR refresh, so development shows the data the call asked for",
          );
    },
  },
  {
    id: "config/next-config-js/allowedDevOrigins",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["allowedDevOrigins"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a project served in development from an origin the option does not allow",
      outcome:
        "which origins reach a development server is a property of how somebody runs it, and no " +
        "source tree records that",
    },
  },
  {
    id: "config/next-config-js/devIndicators",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["devIndicators"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a project that would want the indicator moved or hidden",
      outcome:
        "where a badge sits on somebody's screen is not a fact a codebase can hold an opinion about",
    },
  },
  {
    id: "config/next-config-js/onDemandEntries",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["onDemandEntries"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a project whose development page buffer the defaults size wrongly",
      outcome:
        "the values tune a development server's memory against how a person navigates while " +
        "working, which is not something a source tree holds",
    },
  },

  {
    // The five of this group share one outcome, and it is not that nothing can be said: it is
    // that what can be said is a constraint on a configured value rather than a suggestion.
    id: "config/next-config-js/cssChunking",
    cost: "FS",
    // Which route entries reach a module is knowledge no single file carries, and the alternative —
    // matching specifier text across files — would call two `./styles.css` in different directories
    // one stylesheet. The used detection reads two config keys.
    conditionCost: "GRAFO",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["cssChunking", "experimental.cssChunking"])
        ? match([configPath])
        : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a project whose CSS the default chunking strategy serves badly",
      outcome:
        "nothing in a source tree argues for a bundler setting — what this tool can say arrives " +
        "once the option is set, and it is whether the project's own scripts run a bundler the " +
        "page scopes it to, reported as a constraint",
    },
    // Narrower than the refusal's question and honest about it. Whether the default serves a
    // project badly needs a build; what is decidable is the arrangement in which chunking order
    // can matter at all — a module that imports a stylesheet and is reached from more than one
    // route entry. The page says the default is right for most applications, and the finding says
    // where the choice exists rather than that the default is wrong.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      const entries = routeEntries(context);
      if (entries.size < 2) return NO_MATCH;
      const shared = filesImportingAStylesheet(context).filter(
        (path) => reaching(context.graph, entries, path).size > 1,
      );
      return shared.length === 0
        ? NO_MATCH
        : suggest(
            shared.slice(0, EVIDENCE_LIMIT),
            `${shared.length} ${shared.length === 1 ? "module imports a stylesheet and is" : "modules import a stylesheet and are"} reached from more than one route`,
            "the option is where the sharing is arranged — `graph` on Turbopack trades requests for the unused CSS a route downloads, `'strict'` on webpack keeps import order where two stylesheets depend on each other",
          );
    },
  },
  {
    id: "config/next-config-js/turbopackChunking",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["turbopackChunking", "experimental.turbopackChunking"])
        ? match([configPath])
        : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a project whose client chunks the default thresholds size wrongly",
      outcome:
        "nothing in a source tree argues for a bundler setting — what this tool can say arrives " +
        "once the option is set, and it is whether the project's own scripts run a bundler the " +
        "page scopes it to, reported as a constraint",
    },
    // This condition can say one thing and says only that: the option is unset while a script runs
    // the bundler it configures, so the release's own thresholds are what size the chunks. It does
    // not say the project would benefit. Nothing readable here could: the objection names a
    // chunk-size measurement, and `RecordedWeights` carries first-load bytes by route and nothing
    // about chunk boundaries.
    wouldApplyStrict: (context): Suggestion =>
      defaultInForce(
        context,
        "the chunker's thresholds",
        "the option is where the sizes it merges and splits at are set",
      ),
  },
  {
    id: "config/next-config-js/turbopackMemoryEviction",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, [
        "turbopackMemoryEviction",
        "experimental.turbopackMemoryEviction",
      ])
        ? match([configPath])
        : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a build whose memory the default eviction strategy serves badly",
      outcome:
        "nothing in a source tree argues for a bundler setting — what this tool can say arrives " +
        "once the option is set, and it is whether the project's own scripts run a bundler the " +
        "page scopes it to, reported as a constraint",
    },
    // The same shape, and the same limit. Its objection names a build's memory, which nothing this
    // tool reads records anywhere.
    wouldApplyStrict: (context): Suggestion =>
      defaultInForce(
        context,
        "when memory is reclaimed after a cache snapshot",
        "the option is `'auto'` until it is written, and its page scopes the effect to a dev session with the filesystem cache on",
      ),
  },
  {
    id: "config/next-config-js/turbopackLocalPostcssConfig",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, [
        "turbopackLocalPostcssConfig",
        "experimental.turbopackLocalPostcssConfig",
      ])
        ? match([configPath])
        : NO_MATCH;
    },
    reopenedFrom: {
      condition:
        "a PostCSS configuration in a subdirectory that the root one takes precedence over",
      outcome:
        "nothing in a source tree argues for a bundler setting — what this tool can say arrives " +
        "once the option is set, and it is whether the project's own scripts run a bundler the " +
        "page scopes it to, reported as a constraint",
    },
    // The shape the refusal named is readable after all, and without a second traversal: a PostCSS
    // configuration is written in `.js`, `.mjs` or `.cjs`, which the scan already indexes. So the
    // files the condition needs are in the index the boundary produced, and a config inside a
    // dot-directory is absent because the boundary excluded it rather than because a rule here did.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      if (!runsBundler(context, "turbopack")) return NO_MATCH;
      const root = context.project.root;
      const configs = productionFiles(context.sources)
        .map((file) => file.path)
        .filter((path) => POSTCSS_NAME.test(basename(path)))
        .sort();
      const atRoot = configs.filter((path) => dirname(path) === root);
      const below = configs.filter((path) => dirname(path) !== root);
      if (atRoot.length === 0 || below.length === 0) return NO_MATCH;
      return suggest(
        below.slice(0, EVIDENCE_LIMIT),
        `${below.length} PostCSS ${below.length === 1 ? "configuration sits" : "configurations sit"} below the root, which holds one too`,
        "the option is what makes the framework read the nearer one; without it the root configuration is the only one that applies",
      );
    },
  },
  {
    id: "config/next-config-js/useLightningcss",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["useLightningcss", "experimental.useLightningcss"])
        ? match([configPath])
        : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a project on webpack whose CSS pipeline the faster transformer would serve",
      outcome:
        "nothing in a source tree argues for a bundler setting — what this tool can say arrives " +
        "once the option is set, and it is whether the project's own scripts run a bundler the " +
        "page scopes it to, reported as a constraint",
    },
    // The page states both halves this needs. *If this option is not set, Next.js on webpack uses
    // PostCSS with postcss-preset-env by default*, and *Turbopack always uses Lightning CSS* — so
    // the option means something only where a script runs webpack, and the finding names the
    // transformer in force rather than grading it.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      if (!runsBundler(context, "webpack")) return NO_MATCH;
      const styles = colocatedMatching(context, STYLESHEET_NAME);
      return styles.length === 0
        ? NO_MATCH
        : suggest(
            styles.slice(0, EVIDENCE_LIMIT),
            `a script runs webpack, and ${styles.length} ${styles.length === 1 ? "stylesheet sits" : "stylesheets sit"} beside a route`,
            "the option puts Lightning CSS on the webpack side, where the page says the framework otherwise runs PostCSS with postcss-preset-env — the Turbopack side already uses it",
          );
    },
  },

  {
    // The four of this group are trades the framework offers both sides of, and which side wins
    // is decided outside the source: a built bundle's size, a deployment's adapter, a network.
    // That is neither "nobody has looked" nor "not readable" — it is not in the repository.
    id: "config/next-config-js/productionBrowserSourceMaps",
    cost: "FS",
    conditionCost: "BUILD",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["productionBrowserSourceMaps"])
        ? match([configPath])
        : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a project that would want readable stack traces from production",
      outcome:
        "the page names no tool that needs them and states the cost in its own terms, so the " +
        "trade is one nothing in a source tree settles",
    },
    // It reports what the build emitted, not what the project should want. The trade the refusal
    // named is still the reader's to make; what this adds is the figure the page states the cost
    // in — how many maps the build wrote and what they weigh — which the project has no other way
    // to see. A build directory this could not read yields a reason, and a reason is not a zero.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      if (context.build.status !== "resolved") return NO_MATCH;
      if (!isEnabled(context, ["productionBrowserSourceMaps"])) return NO_MATCH;
      const maps = context.build.value.browserSourceMaps;
      if (maps.reason !== undefined || maps.count === 0) return NO_MATCH;
      return suggest(
        [configPath],
        `the option is on and the build emitted ${maps.count} browser source ${maps.count === 1 ? "map" : "maps"}, ${Math.round(maps.bytes / 1024)} KiB in total`,
        "the option is what puts them there, and the page states the cost in exactly this figure — what the build ships beside the code it serves",
      );
    },
  },
  {
    id: "config/next-config-js/supportsImmutableAssets",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["supportsImmutableAssets"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a project whose static assets the deployment could cache indefinitely",
      outcome:
        "the page states that without an adapter enabling the feature the option has no effect, " +
        "and addresses adapter authors rather than applications — which adapter a deployment " +
        "runs is not in the repository",
    },
  },
  {
    id: "config/next-config-js/inlineCss",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["inlineCss", "experimental.inlineCss"])
        ? match([configPath])
        : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a project whose CSS is small enough for inlining to pay",
      outcome:
        "what decides it is the size of the built stylesheet, which the build produces and the " +
        "source does not state — the page's own guidance turns on that size, and the feature " +
        "does not run in development at all",
    },
    // The refusal is right that the size decides it and the source does not state it. The page
    // names a proxy for the size, though, and names it as an example rather than a rule: *this
    // trade-off works for small CSS (atomic frameworks like Tailwind), but adds overhead for
    // larger bundles*. So the condition reads the framework, not the size, and the finding says
    // which one it read so a reader can disagree with the proxy.
    wouldApplyStrict: (context): Suggestion => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      const atomic = ATOMIC_CSS.filter((name) => declaresPackage(context, name));
      return atomic.length === 0
        ? NO_MATCH
        : suggest(
            [configPath],
            `the manifest declares ${atomic.join(", ")}`,
            "the option inlines the stylesheet into the document instead of linking it, which the page says pays for the small CSS an atomic framework generates and costs on larger bundles — the size is the project's to check",
          );
    },
  },
  {
    id: "config/next-config-js/prefetchInlining",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["prefetchInlining", "experimental.prefetchInlining"])
        ? match([configPath])
        : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      // Reopened on the reading that the installed release states its own default, so a condition
      // could rest on the copy being analysed rather than on a release number written here. The
      // reopening closed on what the releases actually do: the option's page arrived in 16.3.0,
      // and 16.3.0 is the release that flipped the default to `true`. Before it the default is
      // `false` and there is no page, so no entry exists to report against; from it there is a
      // page and the behaviour is already on. Page and default moved together, which leaves the
      // condition with no release it can hold on.
      condition:
        "an installed release defaulting the option to false with the project setting it nowhere, " +
        "read from the release rather than from a version comparison",
      outcome:
        "the option's page and the default's flip to true arrived in the same release, so a " +
        "release documenting the option already has the behaviour on and one defaulting it off " +
        "documents no page for the entry to report against — and what a different threshold would " +
        "buy is a property of a network rather than of a codebase",
    },
  },

  {
    // The only option in the queue answered by the derivation rather than by a reading of the
    // project: its page carries `version: legacy`, and a legacy entry is filed under Not
    // applicable before any heuristic runs. A second opinion beside that would be two answers to
    // one question.
    id: "config/next-config-js/exportPathMap",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["exportPathMap"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a project exporting pages the option would map",
      outcome:
        "the page is declared legacy and deprecated in favour of generateStaticParams, and the " +
        "derivation files a legacy entry as not applicable before any condition runs — a page " +
        "that stopped carrying that status would leave this option unexamined again",
    },
  },
  {
    // The hardest consequence anything in this queue produced: the page says the build exits.
    // Reported as a constraint, in the same register as every other finding — a project moving to
    // TypeScript 7 may be holding this combination knowingly.
    id: "config/next-config-js/useTypeScriptCli",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["useTypeScriptCli", "experimental.useTypeScriptCli"])
        ? match([configPath])
        : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a project that would want the compiler API rather than the CLI checker",
      outcome:
        "which checker runs is a build preference no source tree argues for — what the page does " +
        "name is a combination that fails, the opt-out under TypeScript 7, reported as a constraint",
    },
  },

  {
    id: "config/next-config-js/proxyClientMaxBodySize",
    cost: "FS",
    conditionCost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, [
        "proxyClientMaxBodySize",
        "experimental.proxyClientMaxBodySize",
      ])
        ? match([configPath])
        : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a proxy buffering request bodies the default limit truncates",
      outcome:
        "what a body should be allowed to weigh is a property of the traffic, not of the code — " +
        "what the page does name is the prerequisite, a proxy, and the option set without one is " +
        "reported as a constraint",
    },
    // The mirror of the absent-prerequisite constraint next door, and it reads the proxy from the
    // same place so the two cannot disagree about one project. The page publishes the code the
    // limit acts on — a proxy awaiting `request.text()` — and says a body over the limit arrives
    // buffered to it with a warning logged rather than the request failing.
    //
    // Only a receiver the framework's own examples name. `NextResponse.json` is the commonest
    // call in a proxy file, and a reading anchored on the method alone would report every
    // response the file builds as a body it read.
    wouldApplyStrict: (context): Suggestion => {
      const paths = ["proxyClientMaxBodySize", "experimental.proxyClientMaxBodySize"];
      if (!isDefinitelyUnset(context, paths)) return NO_MATCH;
      const proxy = proxyConventionFile(context.project.root, context.project.pageExtensions);
      if (proxy === undefined) return NO_MATCH;
      const file = context.sources.byPath.get(proxy);
      if (file === undefined) return NO_MATCH;

      const methods = [
        ...new Set(
          file.bodyReads
            .filter((read) => REQUEST_NAMES.has(read.receiver))
            .map((read) => `${read.receiver}.${read.method}()`),
        ),
      ].sort();
      return methods.length === 0
        ? NO_MATCH
        : suggest(
            [proxy],
            `the proxy reads the request body with ${methods.join(", ")}`,
            "the option sets the size that read is buffered to; past the default the page says the body arrives truncated and a warning is logged rather than the request failing",
          );
    },
  },
  {
    id: "config/next-config-js/htmlLimitedBots",
    cost: "FS",
    conditionCost: "AST",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["htmlLimitedBots"]) ? match([configPath]) : NO_MATCH;
    },
    reopenedFrom: {
      condition: "a configured expression that drops crawlers the default list covers",
      outcome:
        "the page states on its own face that a configured value overrides the default list, so " +
        "reporting it would tell an author what the option does by definition — and which " +
        "crawlers a project wants served blocking metadata is not readable from a codebase",
    },
    // The refusal asked what a project wants; a `robots` file naming a crawler by user agent has
    // already said which ones matter to it. Where that literal is one the installed expression
    // does not match, the framework serves it streaming metadata. The expression is read from the
    // installed package, so a release that stops exporting it takes the condition with it rather
    // than leaving a copy of the list here.
    wouldApplyStrict: (context): Suggestion => {
      if (!isDefinitelyUnset(context, ["htmlLimitedBots"])) return NO_MATCH;
      const robots = robotsConventionFile(context);
      if (robots === undefined) return NO_MATCH;
      const file = context.sources.byPath.get(robots);
      if (file === undefined) return NO_MATCH;

      const expression = readHtmlLimitedBots(context.project.installedNext);
      if (expression.status !== "resolved") return NO_MATCH;

      const uncovered = [
        ...new Set(
          file.userAgents.filter(
            (agent) => agent !== EVERY_USER_AGENT && !expression.value.test(agent),
          ),
        ),
      ].sort();
      return uncovered.length === 0
        ? NO_MATCH
        : suggest(
            [robots],
            `this names ${uncovered.join(", ")}, which the installed release's bot expression does not match`,
            "the option names the agents served blocking metadata; an agent outside the default expression is served the streaming kind, which its page says arrives after the shell",
          );
    },
  },
  {
    // The closer call of the two refusals. Next 16 requires a Node long past 18, so the polyfill
    // the page describes is not in play — but the page says what happened before 18, not what
    // happens now, and a finding resting on the gap between those would be a sentence the
    // framework did not write.
    id: "config/next-config-js/httpAgentOptions",
    cost: "FS",
    detectUsed: (context): Verdict => {
      const configPath = context.project.config?.path;
      if (configPath === undefined) return NO_MATCH;
      return isConfigured(context, ["httpAgentOptions"]) ? match([configPath]) : NO_MATCH;
    },
    noSuggestion: {
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a project whose server-side fetches the keep-alive setting would change",
      outcome:
        "the page describes the behaviour this option turns off as belonging to Node versions " +
        "prior to 18 and does not say what the option does on a newer one, so calling it inert " +
        "today would be our inference rather than the framework's statement",
    },
  },
];

/**
 * The reason the derived option predicate carries. Exported so catalog assembly can refuse an
 * authored entry that reuses it: the type system requires a reason, but cannot require that the
 * reason be about the entry, and a borrowed one reports an examination that never happened.
 */
export const DERIVED_OPTION_REASON =
  "this option page has not been examined one at a time for a condition of its own";

/**
 * The options to examine next: the ones some project actually configures. Data rather than a
 * comment, so a test can hold it to naming nothing already authored — an option listed here is a
 * promise that nobody has looked at it yet, and one that has been looked at must leave.
 *
 * Ordered this way because the inverse reading needs a configured value to read, and the inverse
 * reading is what has produced every condition so far. An option nobody sets offers only the
 * forward one — that a project ought to set something it has not — and that has been refused every
 * time it was measured. The earlier ordering was by how decidable a condition looked, which put
 * effort where the evidence says none of it pays.
 *
 * **Everything listed below is readable because `overconfigured-app` sets it, and for no other
 * reason.** That fixture was written to make these options examinable, so a value in it says a
 * condition can be written and proven to fire. It says nothing about whether the option is worth
 * examining first: nobody chose to set these, we did. Priority still comes from the projects that
 * are not written for this repository, and today none of them sets any of these — so the whole
 * list is ordered behind an empty set rather than ahead of one. A real project that starts setting
 * one of these moves it to the front, and that move is the evidence, not its position here.
 *
 * The groups are formed by what a condition over them would have to read, so the reading is written
 * once per group rather than once per option. Each entry is the option's page name, never the
 * path it occupies in a configuration: `configOptionPredicate` already tries both the root and the
 * `experimental` container for a name, and a page is what an entry promises to examine.
 *
 * Five pages of the remainder name something that is not a key of `NextConfig`, and
 * `configOptionPredicate` builds its lookup from the page name. `PAGE_KEYS` maps four of them to
 * the keys their own examples write, so those four report as used and can be examined like any
 * other page; `turbopackFileSystemCache` and `turbopackIgnoreIssue` have been examined, each with
 * a refusal authored above. `appDir` is the one that cannot join: its page is `version: legacy`,
 * so it is filed as not applicable before any predicate runs.
 *
 * The rest of the remainder is not listed. It is a rule about what is configured rather than a
 * list, so an option a project starts setting joins by the rule, and naming the others would be a
 * list to edit every time a release adds a page.
 */
export const EXAMINATION_TRANCHES: readonly (readonly string[])[] = [];

/** The directives that open a cache scope, matching what the functions catalog reads. */
const CACHE_DIRECTIVES = ["use cache", "use cache: private", "use cache: remote"] as const;

/**
 * Pages whose name is not the key they document, with the keys their own examples name.
 *
 * `configOptionPredicate` builds its lookup from the page name, which is right for almost every
 * page and wrong for these: a project configuring `cacheHandler` was reporting nothing for the
 * page that documents it. Two of them are renames and two document several keys each.
 *
 * Sourced from each page's examples, checked against `config-shared.d.ts` in both installed
 * fixtures — a page naming a key the type does not declare gets no mapping, because a page and a
 * type disagreeing is a fact to record rather than one to settle by picking a side.
 *
 * `appDir` is deliberately absent. It is the fifth page whose name is not a key, and it needs no
 * mapping: its page is `version: legacy`, and a legacy entry is filed as not applicable before any
 * predicate runs. No key would change what it reports.
 */
const PAGE_KEYS: Readonly<Record<string, readonly string[]>> = {
  // A rename. The page kept the old title; the key has been `cacheHandler` since.
  incrementalCacheHandlerPath: ["cacheHandler"],
  // The key did not change name, it moved into a container.
  turbopackIgnoreIssue: ["turbopack.ignoreIssue"],
  // One page over three settings of one capability.
  staticGeneration: [
    "experimental.staticGenerationRetryCount",
    "experimental.staticGenerationMaxConcurrency",
    "experimental.staticGenerationMinPagesPerWorker",
  ],
  // Two, not three: 16.3.0 declares `turbopackSeedCacheFromWorktree` and no page names it, so it
  // stays unreported — the surface is what the reference enumerates.
  turbopackFileSystemCache: [
    "experimental.turbopackFileSystemCacheForDev",
    "experimental.turbopackFileSystemCacheForBuild",
  ],
};

/**
 * Conditions authored for pages the derived predicate answers for.
 *
 * Attached to the derived set rather than lifted into an authored entry, for the reason the
 * refusals below are: `PAGE_KEYS` stays the one place a page's keys are written, and the
 * `configured through …` note a project reads keeps being built from it. An authored entry would
 * be a second copy of that mapping, which is how a mapping and a report come to disagree.
 *
 * Every one of these is `wouldApplyStrict` and carries no `reopenedFrom`. A page answered by the
 * derived predicate carried the group's sentence, which is an abstention about a group rather than
 * a measurement about an entry — so there is no refusal being replaced and nothing to copy, and
 * assembly refuses a carrier composed to fill the field.
 */
const CONDITIONS_FOR_DERIVED_PAGES: Readonly<Record<string, SuggestionPredicate>> = {
  // The page is a rename carrying its old title: the key has been `cacheHandler` since 14.1.0,
  // and its own "Good to know" says the singular serves ISR, route handler responses and
  // optimised images and is *not* used by `'use cache'` directives, for which the plural is the
  // option. So this is not the page above it, and delegating to that entry would file a claim
  // about the server cache under the entry for the `'use cache'` cache.
  //
  // What the pair makes readable is the asymmetry. A project that filled `cacheHandlers` has
  // written into its own configuration that the `'use cache'` cache is not the framework's
  // in-memory one; the page states the singular's caches are untouched by that. The finding names
  // both keys and stops there — whether those caches ought to be shared or persisted is the
  // deployment fact this family declines everywhere else.
  incrementalCacheHandlerPath: (context): Suggestion => {
    const configPath = context.project.config?.path;
    if (configPath === undefined) return NO_MATCH;
    const plural = readFlagPresence(context.project.config, "cacheHandlers");
    if (plural.status !== "resolved" || !plural.value) return NO_MATCH;
    if (!isDefinitelyUnset(context, ["cacheHandler"])) return NO_MATCH;
    return suggest(
      [configPath],
      "cacheHandlers is configured and cacheHandler is not",
      "the singular option serves the caches its page says the plural does not — ISR, route handler responses and optimised images — which stay in the per-process store meanwhile",
    );
  },
};

/**
 * Refusals authored for pages the derived predicate answers for.
 *
 * Two pages belong to the bundler family by subject and sat outside its count by oversight. They
 * needed an examination, not a predicate: the reading each would rest on is unavailable or answers
 * a different question, so each ends in a refusal. Written here rather than as authored entries so
 * the derived `detectUsed` keeps answering — a page whose name is not its key reports through
 * `PAGE_KEYS`, and the refusal changes the verdict rather than the mapping.
 *
 * Neither is a reopening. Both carried the group's sentence, which is an abstention about a group
 * rather than a measurement about an entry, so there is nothing to copy into a `reopenedFrom` and
 * assembly refuses one.
 */
const EXAMINED_WITHOUT_A_CONDITION: Readonly<Record<string, PredicateSet["noSuggestion"]>> = {
  turbopackFileSystemCache: {
    kind: "examined",
    measuredAgainst: "16.3.0",
    failed: "condition",
    condition:
      "a build environment that never preserves .next/cache, which is the one case the page argues for",
    outcome:
      "the page's actionable sentence points the other way — set the build key to false where " +
      "the cache will not be read — so there is no unset option for a would-apply to argue for; " +
      "both keys are on by default on 16.3.0, and the reading it would need is of a Dockerfile " +
      "or a CI job definition, which the scan reads none of",
  },
  staticGeneration: {
    kind: "examined",
    measuredAgainst: "16.3.0",
    failed: "condition",
    condition:
      "a project whose build the three settings would size differently — how many times a failed " +
      "page generation is retried, how many pages one worker takes, and how many must exist " +
      "before another worker starts",
    outcome:
      "a retry count answers a build that fails intermittently and the two worker settings answer " +
      "the machine the build runs on, so all three are properties of the run rather than of the " +
      "source — and the page names no situation of its own beyond advanced use cases, so there is " +
      "no sentence to convert either",
  },
  turbopackIgnoreIssue: {
    kind: "examined",
    measuredAgainst: "16.3.0",
    failed: "condition",
    condition:
      "a package the code imports and the project does not have, under a Turbopack script, which is the warning the page's own example suppresses",
    outcome:
      "the reading exists and answers a different question: an unresolved specifier is a package " +
      "the project does not have, and the option is for one it deliberately does not have — " +
      "nothing in a file separates an optional dependency guarded by try/catch from a dependency " +
      "somebody forgot, so a suggestion here would offer to silence the warning either way",
  },
};

/** Exported for the test that holds every mapped key to the installed type. */
export const MAPPED_PAGE_KEYS = PAGE_KEYS;

/** The reference gives each `next.config` option its own page under one directory. */
export const CONFIG_OPTION = "config/next-config-js/";

/**
 * Builds the predicate for a page documenting a single `next.config` option, or nothing when
 * the entry is not one. Derived rather than authored: the pages need no list, and an option a
 * later version documents is covered by its page existing.
 *
 * The reason it carries is about the group, not about any one option in it. That distinction is
 * the point: `basePath` genuinely has nothing in a codebase arguing for it, and stating that as
 * a fact about every option was a claim four of them turned out to contradict. Those four are
 * authored above. What is left here is the honest version — nobody has examined these one at a
 * time — and it stops asserting an examination that did not happen.
 */
export function configOptionPredicate(entry: SurfaceEntry): PredicateSet | undefined {
  if (!entry.id.startsWith(CONFIG_OPTION)) return undefined;
  const option = entry.id.slice(CONFIG_OPTION.length);
  if (option === "" || option.includes("/")) return undefined;

  // A page whose name is not its key carries them explicitly; every other page is its own key,
  // and a promoted option keeps working under the old one, so both spellings are tried.
  const mapped = PAGE_KEYS[option];
  const paths = mapped ?? [option, `experimental.${option}`];
  const detectUsed = (context: PredicateContext): Verdict => {
    const configPath = context.project.config?.path;
    if (configPath === undefined) return NO_MATCH;
    const found = paths.filter((path) => {
      const present = readFlagPresence(context.project.config, path);
      return present.status === "resolved" && present.value;
    });
    if (found.length === 0) return NO_MATCH;
    // A page documents one capability, and configuring any of its keys uses that capability.
    // Which ones were found is evidence rather than bucket: one of three and three of three
    // are both used, and the difference has to be readable somewhere.
    return mapped === undefined
      ? match([configPath])
      : match([configPath], `configured through ${found.join(", ")}`);
  };

  // A page with a condition of its own carries it instead of a reason, and keeps the detection
  // above: gaining a verdict must not change which keys report the page as used.
  const condition = CONDITIONS_FOR_DERIVED_PAGES[option];
  if (condition !== undefined) {
    return { id: entry.id, cost: "FS", detectUsed, wouldApplyStrict: condition };
  }

  return {
    id: entry.id,
    cost: "FS",
    detectUsed,
    noSuggestion: EXAMINED_WITHOUT_A_CONDITION[option] ?? {
      kind: "abstained",
      measuredAgainst: "16.3.0",
      why: DERIVED_OPTION_REASON,
    },
  };
}
