import { join, relative } from "node:path";
import { rootEntryFiles } from "../collect/conventions.js";
import type { SurfaceEntry } from "../collect/docs.js";
import { reachedFromAny, reaching } from "../collect/graph.js";
import { prerenderedBySegment } from "../collect/output.js";
import type { RouteNode } from "../collect/routes.js";
import { dynamicPagesWithoutStaticParams as selectUnprerenderedDynamicPages } from "../collect/routes.js";
import type { GlobalAccess, SourceFileRecord } from "../collect/sources.js";
import {
  callsResolvedTo,
  filesImporting,
  filesImportingModule,
  hasDirective,
  placedElsewhere,
  productionFiles,
} from "../collect/sources.js";
import { FUNCTION_SHAPES, INVALIDATION_SYMBOLS } from "./function-modules.js";
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
import { match, NO_MATCH, suggest } from "./types.js";

const CACHE_DIRECTIVES = ["use cache", "use cache: private", "use cache: remote"] as const;

/**
 * The flag both auth interrupt APIs need. One documentation page gates the functions and the file
 * conventions of the same name, so one constant gates both halves of the catalog: they were
 * allowed to drift apart once, and the functions spent that time reported as backlog on projects
 * that cannot call them.
 */
export const AUTH_INTERRUPTS = "experimental.authInterrupts";

/**
 * The flag `global-not-found` needs. Beside `AUTH_INTERRUPTS` for the same reason: the convention
 * and the coverage it grants a `notFound()` call both gate on it, and a second spelling of the
 * flag would let one of them honour a file the other does not.
 */
export const GLOBAL_NOT_FOUND = "experimental.globalNotFound";

/** Entries whose documentation opens by telling the reader to enable a flag. */
const REQUIRED_FLAG: Readonly<Record<string, string>> = {
  "functions/forbidden": AUTH_INTERRUPTS,
  "functions/unauthorized": AUTH_INTERRUPTS,
};

function cachedFiles(context: PredicateContext): SourceFileRecord[] {
  return context.sources.files.filter((file) =>
    CACHE_DIRECTIVES.some((directive) => hasDirective(file, directive)),
  );
}

function serverActionFiles(context: PredicateContext): SourceFileRecord[] {
  return context.sources.files.filter((file) => hasDirective(file, "use server"));
}

function callsSymbol(file: SourceFileRecord, module: string, symbol: string): boolean {
  return (file.imports.get(module) ?? []).some(
    (binding) => binding.imported === symbol && !binding.typeOnly,
  );
}

/** Convention files the route tree already identified, keyed by path. */
export function conventionFilePaths(context: PredicateContext): Set<string> {
  const paths = new Set<string>();
  for (const node of context.tree.nodes) {
    for (const convention of node.conventions) {
      if (convention.skippedForFlag === undefined) paths.add(convention.file);
    }
  }
  return paths;
}

/** Detection driven by the authored shape and the symbol derived from the doc title. */
function detectUsed(context: PredicateContext, surface: SurfaceEntry): Verdict {
  const shape = FUNCTION_SHAPES[surface.id];
  if (!shape) return NO_MATCH;

  if (shape.kind === "module") {
    const files = filesImportingModule(context.sources, shape.module);
    return files.length === 0 ? NO_MATCH : match(files.map((f) => f.path));
  }

  if (shape.kind === "fetch") {
    const files = context.sources.files.filter((file) => file.extendedFetchCalls > 0);
    return files.length === 0 ? NO_MATCH : match(files.map((f) => f.path));
  }

  if (shape.kind === "export") {
    // Next.js only honours these names inside a route file, so anywhere else does not count.
    const conventions = conventionFilePaths(context);
    const files = context.sources.files.filter(
      (file) => conventions.has(file.path) && file.exportedNames.includes(surface.title),
    );
    return files.length === 0 ? NO_MATCH : match(files.map((f) => f.path));
  }

  const files = shape.acceptTypeOnly
    ? context.sources.files.filter((file) =>
        (file.imports.get(shape.module) ?? []).some((b) => b.imported === surface.title),
      )
    : filesImporting(context.sources, shape.module, surface.title);
  return files.length === 0 ? NO_MATCH : match(files.map((f) => f.path));
}

function evidenceOf(files: readonly SourceFileRecord[], note: string, gain: string): Suggestion {
  return files.length === 0
    ? NO_MATCH
    : suggest(
        files.map((f) => f.path),
        note,
        gain,
      );
}

/** A cache scope that never calls the given symbol, provable from the file alone. */
function cachedWithout(symbol: string, note: string, gain: string): SuggestionPredicate {
  return (context: PredicateContext): Suggestion =>
    evidenceOf(
      cachedFiles(context).filter((file) => !callsSymbol(file, "next/cache", symbol)),
      note,
      gain,
    );
}

/** Files of one convention that the route tree found and no flag skipped. */
function conventionFiles(context: PredicateContext, name: string): Set<string> {
  const files = new Set<string>();
  for (const node of context.tree.nodes) {
    for (const convention of node.conventions) {
      if (convention.name === name && convention.skippedForFlag === undefined) {
        files.add(convention.file);
      }
    }
  }
  return files;
}

/** Layout files the route tree already identified. */
function layoutFiles(context: PredicateContext): Set<string> {
  const files = new Set<string>();
  for (const node of context.tree.nodes) {
    for (const convention of node.conventions) {
      if (convention.name === "layout" && convention.skippedForFlag === undefined) {
        files.add(convention.file);
      }
    }
  }
  return files;
}

/**
 * A client component that reads the pathname and is rendered from a layout.
 *
 * The hook's page describes that arrangement as the one it exists for: a Client Component
 * imported into a Layout, reading where it is so navigation UI can mark the active section. A
 * component reaching the pathname to answer that question from a layout is reaching for the
 * general API where the documented one names the answer directly.
 *
 * `GRAFO`, and it has to be: the layout renders the component through however many modules sit
 * between them, and no single file shows that it does.
 *
 * Observed rather than proven. Reading the pathname under a layout is what the documented hook
 * replaces, but a component may read it for something the hook does not answer — a key, an href,
 * an analytics call — and the import alone does not say which.
 */
function pathnameReadersUnderALayout(context: PredicateContext): Suggestion {
  const layouts = layoutFiles(context);
  const root = context.project.root;
  const found = new Set<string>();
  for (const { file } of callsResolvedTo(context.sources, "next/navigation", "usePathname")) {
    if (file.isTest) continue;
    for (const [, chain] of reaching(context.graph, layouts, file.path)) {
      // A chain is one line rather than a path, so it is relativised here: the report relativises
      // a single path and would leave every file after the first one absolute.
      found.add(chain.map((path) => relative(root, path)).join(" → "));
    }
  }
  return found.size === 0
    ? NO_MATCH
    : suggest(
        [...found].sort(),
        "these layouts render a client component that reads the pathname, which is the question the segment hooks answer",
        "the hook returns the active segment one level below the layout, so the component follows a route that is renamed rather than a path it takes apart itself",
      );
}

/**
 * Dynamic pages that do not generate their params, less the ones the build already prerendered.
 *
 * The selection is a source reading: without a build the join is empty and every dynamic page it
 * finds survives, which is why the condition stays `AST`. The build only ever subtracts here. A
 * route it recorded as prerendered — in either mode, because the claim is that prerendering did
 * not happen at all — is one the measurement has answered for, and printing the suggestion beside
 * it would state the opposite of what the project's own build produced.
 */
function dynamicPagesWithoutStaticParams(context: PredicateContext): readonly RouteNode[] {
  const prerendered = prerenderedBySegment(context.join);
  return selectUnprerenderedDynamicPages(
    context.tree,
    (file) =>
      context.sources.byPath.get(file)?.exportedNames.includes("generateStaticParams") ?? true,
    (segment) => prerendered.has(segment),
  ).kept;
}

/**
 * The opt-out Next.js replaced. Its own page carries `version: legacy` and names the replacement,
 * so a project still importing it has a gap one file proves.
 *
 * Production files only, and this is the condition that needs that most: in one real project,
 * fourteen of the fifteen files mentioning the symbol are tests mocking the import, and counting
 * them would report fifteen findings where there is one.
 */
function noStoreImporters(context: PredicateContext): SourceFileRecord[] {
  return productionFiles(context.sources).filter((file) =>
    callsSymbol(file, "next/cache", "unstable_noStore"),
  );
}

/**
 * Which replacement to name is the documentation's answer, not ours: `connection` replaces
 * `unstable_noStore`, except under Cache Components, where the same page prefers `io`. The flag
 * picks one entry, so a project is never shown both.
 *
 * An unresolved flag reads as off, which selects `connection` — the conservative direction, since
 * `io` exists only under Cache Components and suggesting it without them would be advice to adopt
 * something the project may not have.
 */
function replacingNoStore(
  underCacheComponents: boolean,
  note: string,
  gain: string,
): SuggestionPredicate {
  return (context) =>
    context.isFlagEnabled("cacheComponents") === underCacheComponents
      ? evidenceOf(noStoreImporters(context), note, gain)
      : NO_MATCH;
}

/**
 * The functions whose call interrupts a render by throwing a value the framework catches. A `catch`
 * that swallows one of these swallows the interrupt, which is the failure `unstable_rethrow` exists
 * to prevent.
 */
const SIGNAL_THROWERS = ["redirect", "permanentRedirect", "notFound", "forbidden", "unauthorized"];

/** Production files whose own code calls one of the framework's signal throwers. */
function signalThrowingFiles(context: PredicateContext): Set<string> {
  const files = new Set<string>();
  for (const symbol of SIGNAL_THROWERS) {
    for (const { file } of callsResolvedTo(context.sources, "next/navigation", symbol)) {
      if (!file.isTest) files.add(file.path);
    }
  }
  return files;
}

/**
 * A `catch` that reaches a module throwing a framework signal, and never rethrows one.
 *
 * The recorded objection is a statement about reach: *whether a caught error can be a framework
 * signal is a property of what the try block calls, which lives in the file that defines it and not
 * in the one that catches*. That property is exactly what the graph holds, so the objection is
 * answered rather than overridden — this is one of the few conditions in the family that can say
 * that.
 *
 * `GRAFO`, and it has to be: the catcher and the thrower are different files by construction, and
 * the chain between them is the evidence a reader checks.
 *
 * Observed rather than proven. A file may catch for something the chain never reaches, and nothing
 * in the `catch` says which call it was written for; the chain says the two are connected, not that
 * the author meant them to be.
 */
/**
 * Whether the catching file's guarded `try` is around the call that starts this chain.
 *
 * A file holding a catch somewhere and reaching a thrower somewhere are two facts about one file,
 * and reporting them together asserts a third that neither establishes. Measured: three findings on
 * formbricks named files whose only `try` wrapped a call into a module throwing nothing, while the
 * call that does reach a thrower sat outside every `try`.
 *
 * Only the first edge is checked. The chain is `[catcher, next, …, thrower]` and the question is
 * whether the catcher's guarded call goes into `next`; what happens past that is the graph's, and
 * the objection this condition answers is about the catching file.
 */
function theCatchIsAroundTheCall(context: PredicateContext, chain: readonly string[]): boolean {
  const [catcherPath, nextPath] = chain;
  if (catcherPath === undefined || nextPath === undefined) return false;
  const catcher = context.sources.byPath.get(catcherPath);
  if (catcher === undefined) return false;
  const guarded = new Set(catcher.calledUnderACatch);
  if (guarded.size === 0) return false;
  // The local name is what the call site wrote, so an aliased import is answered by its alias.
  for (const reference of catcher.moduleReferences) {
    if (reference.resolution.kind !== "internal" || reference.resolution.path !== nextPath)
      continue;
    for (const binding of catcher.imports.get(reference.specifier) ?? []) {
      if (!binding.typeOnly && guarded.has(binding.local)) return true;
    }
  }
  return false;
}

function catchesReachingASignalThrower(context: PredicateContext): Suggestion {
  const throwers = signalThrowingFiles(context);
  if (throwers.size === 0) return NO_MATCH;

  const catchers = new Set(
    productionFiles(context.sources)
      .filter(
        (file) =>
          file.catchClauses > 0 && !callsSymbol(file, "next/navigation", "unstable_rethrow"),
      )
      .map((file) => file.path),
  );
  if (catchers.size === 0) return NO_MATCH;

  const root = context.project.root;
  const found = new Set<string>();
  for (const thrower of throwers) {
    // A file that both catches and throws is its own case and not a chain, so it is left out: the
    // objection is about what another file does, and there is no other file here.
    for (const [start, chain] of reaching(context.graph, catchers, thrower)) {
      if (start === thrower) continue;
      if (!theCatchIsAroundTheCall(context, chain)) continue;
      found.add(chain.map((path) => relative(root, path)).join(" → "));
    }
  }
  return found.size === 0
    ? NO_MATCH
    : suggest(
        [...found].sort(),
        "these catch blocks reach a module that throws a framework signal, and never rethrow one",
        "the helper rethrows a framework signal and swallows nothing else, so a redirect or a not-found raised below the catch still reaches the framework",
      );
}

/**
 * A root dynamic segment's parameter, read by a module two or more forwards below the segment that
 * declares it.
 *
 * The recorded objection names the reach it lacked: *following a prop from where it is read to
 * where it was declared is a chain of files rather than one*. The chain is what the graph carries.
 * The condition asks for two forwards rather than one, because a component rendered directly by the
 * segment receives the parameter as an argument the framework passed it, and the API replaces
 * threading rather than passing.
 *
 * `GRAFO`. The version gate is the API's own: the entry does not exist on a release that does not
 * document it, so nothing here declares a flag for it.
 */
function rootParamsThreadedDown(context: PredicateContext): Suggestion {
  const roots = context.tree.root.children
    .filter((node) => DYNAMIC_KINDS.has(node.kind))
    .flatMap((node) =>
      node.conventions
        .filter((convention) => convention.skippedForFlag === undefined)
        .map((convention) => convention.file),
    );
  if (roots.length === 0) return NO_MATCH;

  const readers = new Set(
    productionFiles(context.sources)
      .filter((file) => file.readsRouteParams)
      .map((file) => file.path),
  );
  if (readers.size === 0) return NO_MATCH;

  const rootFiles = new Set(roots);
  const projectRoot = context.project.root;
  const found = new Set<string>();
  for (const reader of readers) {
    if (rootFiles.has(reader)) continue;
    for (const [, chain] of reaching(context.graph, rootFiles, reader)) {
      // Three files is the segment, one forward, and the reader — the first chain where the
      // parameter was passed on rather than received.
      if (chain.length < 3) continue;
      found.add(chain.map((path) => relative(projectRoot, path)).join(" → "));
    }
  }
  return found.size === 0
    ? NO_MATCH
    : suggest(
        [...found].sort(),
        "these read a route parameter the root segment declares, reached through modules that pass it on",
        "the helper reads a root parameter wherever it is needed, so the modules in between stop carrying a prop none of them uses",
      );
}

/**
 * A hand-rolled error boundary reached from an `error` convention file.
 *
 * The weak member of the three, and the proposal says so. The recorded objection is that nothing in
 * an import separates a component that catches renders from any other, and the graph does not
 * answer that — it lets the module be opened, and a class extending React's component class is the
 * only shape a boundary has. So the objection is moved rather than answered: this reports a
 * boundary reached from the convention that already is one.
 *
 * `GRAFO`, for the same reason as the two above: the convention file and the boundary are different
 * files, and the chain is what a reader checks.
 */
function boundariesUnderTheErrorConvention(context: PredicateContext): Suggestion {
  const errorFiles = new Set(conventionFiles(context, "error"));
  if (errorFiles.size === 0) return NO_MATCH;

  const root = context.project.root;
  const found = new Set<string>();
  for (const file of productionFiles(context.sources)) {
    if (file.clientReasons?.classComponent !== true) continue;
    if (errorFiles.has(file.path)) continue;
    for (const [, chain] of reaching(context.graph, errorFiles, file.path)) {
      found.add(chain.map((path) => relative(root, path)).join(" → "));
    }
  }
  return found.size === 0
    ? NO_MATCH
    : suggest(
        [...found].sort(),
        "these error boundaries hand-roll what the convention above them already provides",
        "the helper reports a caught render error to the framework, so the boundary keeps its own UI and stops swallowing what the framework needs to see",
      );
}

/**
 * Client files that navigate by hand, read the path by hand, or take the query string apart by
 * hand. One shape per entry, and each is a decision the project has already made in code: the
 * condition names the API that covers it rather than proposing that the work should exist.
 *
 * Client files only. On the server none of these globals exists, so a file outside the closure
 * writing one is code that never runs rather than a hand-rolled equivalent.
 */
function clientFilesWriting(
  context: PredicateContext,
  holds: (access: GlobalAccess) => boolean,
): string[] {
  return productionFiles(context.sources)
    .filter((file) => context.graph.clientClosure.has(file.path))
    .filter((file) => file.globalAccess.some(holds))
    .map((file) => file.path)
    .sort();
}

/** The chains that navigate: assigning the URL, or pushing onto the history stack. */
function navigatesByHand(access: GlobalAccess): boolean {
  if (access.path === "location.href" && access.assigned) return true;
  return [
    "location.assign",
    "location.replace",
    "history.pushState",
    "history.replaceState",
  ].includes(access.path);
}

/**
 * A file reading the user-agent header by name and matching the value against something written
 * down.
 *
 * The recorded objection is precise about which half is missing: reading the header *is one line*,
 * and *whether the value is then parsed or passed through is a decision about what the code does
 * with it*. So the condition asks for both halves. A file that reads the header and passes it on is
 * not the shape, which is the objection honoured rather than argued with.
 */
function parsesTheUserAgent(context: PredicateContext): string[] {
  return productionFiles(context.sources)
    .filter((file) => file.getArguments.includes("user-agent") && file.matchesAValue)
    .map((file) => file.path)
    .sort();
}

/**
 * Server modules dropping a promise on the floor before they return.
 *
 * The shape the helper exists to replace: work started and not waited for, so the response may go
 * out before it finishes. Only a call to a function the file itself declares `async`, because that
 * declaration is what says the dropped value is a promise — a call to an imported name may return
 * anything, and reporting one would be a guess about another file.
 *
 * Outside the client closure, because the helper is a server API and a promise dropped in the
 * browser is not the thing it schedules.
 */
function serverModulesDroppingPromises(context: PredicateContext): string[] {
  const onTheServer = runsOnTheServer(context);
  return productionFiles(context.sources)
    .filter((file) => file.unawaitedLocalAsyncCalls.length > 0 && onTheServer(file))
    .map((file) => file.path)
    .sort();
}

/** Route handlers, which is where both request-and-response conditions read. */
function routeHandlerFiles(context: PredicateContext): SourceFileRecord[] {
  const handlers = conventionFiles(context, "route");
  return productionFiles(context.sources).filter((file) => handlers.has(file.path));
}

/**
 * The root layout, which is the only file some of the restatements below have to cite.
 *
 * A condition whose whole content is *the project does not do this* has no file to point at, and
 * the catalog refuses a match with no evidence — rightly, because a finding nobody can check is
 * worse than no finding. So these cite the root of the tree: not because the root is the problem,
 * but because it is the project, and the finding is about the project.
 */
function rootLayoutFile(context: PredicateContext): string | undefined {
  return context.tree.root.conventions.find(
    (convention) => convention.name === "layout" && convention.skippedForFlag === undefined,
  )?.file;
}

/** Whether any production file imports a symbol from a framework module. */
function projectImports(context: PredicateContext, module: string, symbol: string): boolean {
  return productionFiles(context.sources).some((file) => callsSymbol(file, module, symbol));
}

/**
 * A condition whose text is *the project does not do this*, cited against the root of the tree.
 *
 * Written and labelled rather than written and defended. Restated as a suggestion it says *this API
 * exists and you are not using it*, which is the Used bucket read backwards — so the corpus record
 * marks it, the disclosure counts it, and no evidence can promote it, because any project it fires
 * on is an instance of its own objection.
 */
function absentEverywhere(
  module: string,
  symbol: string,
  note: string,
  gain: string,
): SuggestionPredicate {
  return (context): Suggestion => {
    if (projectImports(context, module, symbol)) return NO_MATCH;
    const root = rootLayoutFile(context);
    return root === undefined ? NO_MATCH : suggest([root], note, gain);
  };
}

/** Convention files of one name that do not export a given symbol. */
function conventionsMissingExport(
  context: PredicateContext,
  name: string,
  symbol: string,
): string[] {
  const files = conventionFiles(context, name);
  return productionFiles(context.sources)
    .filter((file) => files.has(file.path) && !file.exportedNames.includes(symbol))
    .map((file) => file.path)
    .sort();
}

/** The image conventions whose page documents the metadata generator and the response helper. */
const IMAGE_CONVENTIONS = ["opengraph-image", "twitter-image", "icon", "apple-icon"] as const;

/** Image convention files, across the four names the reference documents. */
function imageConventionFiles(context: PredicateContext): string[] {
  return IMAGE_CONVENTIONS.flatMap((name) => [...conventionFiles(context, name)]).sort();
}

/** Server-side files building a response that carries a given status literal, outside a handler. */
function redirectsByHand(context: PredicateContext, status: number): string[] {
  // A route handler answering with a redirect is doing what a handler is for, so it is not the
  // shape: the helper interrupts a render, and a handler has no render to interrupt.
  const handlers = conventionFiles(context, "route");
  const onTheServer = runsOnTheServer(context);
  return productionFiles(context.sources)
    .filter(
      (file) => !handlers.has(file.path) && file.statusValues.includes(status) && onTheServer(file),
    )
    .map((file) => file.path)
    .sort();
}

/**
 * One of the two auth interrupts adopted and the other never reached for.
 *
 * Their objection is precise and this cannot answer it: inside a render the hand-rolled equivalent
 * is a branch over a value the file does not define, and nothing separates that from any other
 * conditional render. So the condition does not read renders at all. It reads the pair — a project
 * that adopted one has already decided the interrupt pattern is right, and the missing half is a
 * gap rather than a preference.
 */
function adoptedOnlyTheOtherInterrupt(present: string, missing: string): SuggestionPredicate {
  return (context): Suggestion => {
    if (projectImports(context, "next/navigation", missing)) return NO_MATCH;
    const files = productionFiles(context.sources)
      .filter((file) => callsSymbol(file, "next/navigation", present))
      .map((file) => file.path)
      .sort();
    return files.length === 0
      ? NO_MATCH
      : suggest(
          files,
          `these reach for ${present} and nothing in the project reaches for ${missing}`,
          `the pair covers both halves of the interrupt, and its convention file renders where the other one already does`,
        );
  };
}

/** Server-side calls to `fetch` that state nothing about their caching. The documentation calls a
 * call carrying neither option *auto no cache*: fetched again on every request in development, and
 * once at build time only where the route is already prerendered. That is the shape the framework
 * extended `fetch` for, and the entry that carries it is decided by `cacheComponents` — the same
 * flag split the catalog already uses between `connection` and `io`, so a project is never shown
 * both.
 *
 * The closure is what makes this a server question, and it is read here for the reason
 * `serverComponentsHmrCache` reads it for the neighbouring shape: a fetch in a file reachable from
 * `'use client'` runs in the browser, where the framework's extension does nothing.
 *
 * A call already carrying `cache` — `'no-store'` included — or `next` is excluded by the scan
 * itself: it said what it wants, and the `no-store` shape belongs to the option that argues from
 * it.
 *
 * The public directory is excluded, and it is the only directory that is. Next.js serves what is
 * under it verbatim and never imports it, so a `.mjs` bundle vendored there is an asset the
 * project ships rather than code the framework runs — measured on the corpus, where one project's
 * four WebAssembly glue files were the whole of its report. Everywhere else the single-file rule
 * holds: a build script and a data helper are the same file to one read, and excluding a
 * directory by its name would be a guess about the project rather than a fact about the framework.
 *
 * What does tell them apart is whether the framework loads the file at all. A call only matters to
 * the extended `fetch` where Next.js runs it, and Next.js runs what its route tree and its root
 * files reach. A Node script called by a `package.json` line and a browser bundle kept under
 * `docs/` carry no signal a single read can see — no shebang, no `process.argv`, no client
 * directive — and nothing the app imports reaches either, so neither is on the server Next.js
 * runs.
 */

/**
 * Whether Next.js runs a file on its server: something the framework loads on its own reaches it —
 * a convention file of the route tree, the proxy, the instrumentation hook — it is not on the client
 * side of the boundary, and no reading of the file places it somewhere else.
 *
 * Every condition about server-side code selects through this, and nothing else. Selecting by the
 * absence of a client marker read "not proven to be on the client" as "runs on the server", which is
 * how a Node script, a service worker and a Pages Router component came to be told about `after` and
 * about the framework's `fetch` options; the signals that answered those still let through a script
 * run from a `package.json` line, a browser bundle beside the docs and modules only an AWS Lambda
 * handler imports, none of which shows one.
 *
 * The graph only removes files here, never selects one, which is what `conditionCostNarrows` records
 * for the conditions that call it. A specifier resolving nowhere shrinks what is reached, which the
 * report discloses beside the client closure, and costs a suggestion rather than making a false one.
 */
export function runsOnTheServer(context: PredicateContext): (file: SourceFileRecord) => boolean {
  // Built once per selection, not once per file: the convention set is a walk of the whole tree,
  // and rebuilding it inside a filter turned a scan of a real project from 12s into 25s.
  const conventions = conventionFilePaths(context);
  const roots = rootEntryFiles(context.project.pageExtensions)
    .map((segments) => join(context.project.root, ...segments))
    .filter((path) => context.sources.byPath.has(path));
  const reached = reachedFromAny(context.graph, [...conventions, ...roots]);
  return (file) =>
    reached.has(file.path) &&
    !context.graph.clientClosure.has(file.path) &&
    placedElsewhere(file, (path) => conventions.has(path)) === undefined;
}

export function plainServerFetches(context: PredicateContext): SourceFileRecord[] {
  // `public/` is one of the signals now, so the path check it used to keep is gone with it.
  const onTheServer = runsOnTheServer(context);
  return productionFiles(context.sources).filter(
    (file) => file.plainFetchCalls > 0 && onTheServer(file),
  );
}

export const PLAIN_FETCH_NOTE =
  "these server-side calls pass neither cache nor next, so nothing states how long their result may be reused";

const METADATA_EXPORTS = ["generateMetadata", "metadata"] as const;

/** Whether a convention file exports either half of the metadata API. */
function statesMetadata(context: PredicateContext, file: string | undefined): boolean {
  if (file === undefined) return false;
  const record = context.sources.byPath.get(file);
  return (
    record !== undefined && METADATA_EXPORTS.some((name) => record.exportedNames.includes(name))
  );
}

/** The fields the framework documents as moved out of metadata and into the viewport export. */
const VIEWPORT_KEYS = ["viewport", "themeColor", "colorScheme"] as const;

/**
 * Files exporting a metadata object that still carries a viewport field. The documentation moved
 * these three out of metadata and into the viewport export; an object still holding one is the
 * shape, and it is the object's own keys that say so.
 *
 * Read off any production file rather than off convention files alone: a metadata object is
 * exported from a page or a layout, and the export is what the framework reads whichever file it
 * sits in.
 */
function metadataObjectsCarryingViewport(context: PredicateContext): string[] {
  return productionFiles(context.sources)
    .filter((file) => {
      const keys = file.exportedObjectKeys.get("metadata");
      return keys !== undefined && VIEWPORT_KEYS.some((key) => keys.includes(key));
    })
    .map((file) => file.path)
    .sort();
}

/** The live file of a convention in a node, or nothing where the flag skipped it. */
function conventionFile(node: RouteNode, name: string): string | undefined {
  return node.conventions.find(
    (convention) => convention.name === name && convention.skippedForFlag === undefined,
  )?.file;
}

const DYNAMIC_KINDS = new Set(["dynamic", "catch-all", "optional-catch-all"]);

/**
 * Pages whose title cannot name the entity their URL does. A page under a dynamic segment that
 * exports neither the metadata function nor a metadata object, in a route where no layout above it
 * exports either, has a fixed title for every value the segment takes.
 *
 * A page inheriting a template from a layout that exports one is not the shape: the layout decides
 * what the title is, and the page has nothing to add to that decision. A page under no dynamic
 * segment is not the shape either — a fixed title for a fixed page is not a gap.
 *
 * The route tree answers which segments are dynamic and which layouts sit above (FS); the file
 * answers what it exports (AST). The condition declares AST, the higher of the two.
 */
function pagesThatCannotVaryTheirTitle(context: PredicateContext): string[] {
  const found: string[] = [];
  const walk = (node: RouteNode, underDynamic: boolean, titledAbove: boolean): void => {
    const dynamic = underDynamic || DYNAMIC_KINDS.has(node.kind);
    // The node's own layout wraps its page, so it counts as above it.
    const titled = titledAbove || statesMetadata(context, conventionFile(node, "layout"));
    const page = conventionFile(node, "page");
    if (page !== undefined && dynamic && !titled && !statesMetadata(context, page)) {
      found.push(page);
    }
    for (const child of node.children) walk(child, dynamic, titled);
  };
  walk(context.tree.root, false, false);
  return found.sort();
}

/**
 * Prerequisites that rule an entry out. A dismissal is a stronger claim than a suggestion — a
 * reader who sees an API ruled out stops thinking about it — so each rests on something absent
 * that the tool observes, never on a project having chosen not to adopt something.
 */
const NOT_APPLICABLE: Readonly<Record<string, Predicate>> = {
  // The helper generates several sitemaps from one sitemap convention. With no convention there
  // is nothing to generate from, and the question does not arise.
  "functions/generate-sitemaps": (context): Verdict => {
    const sitemaps = context.tree.nodes
      .flatMap((node) => node.conventions)
      .filter(
        (convention) => convention.name === "sitemap" && convention.skippedForFlag === undefined,
      );
    return sitemaps.length === 0
      ? match(
          [context.project.appDirectory.path],
          "the app directory holds no sitemap to generate several of",
        )
      : NO_MATCH;
  },
};

const WOULD_APPLY: Readonly<Record<string, SuggestionPredicate>> = {
  "functions/connection": replacingNoStore(
    false,
    "these import unstable_noStore, which its own documentation marks legacy in favour of connection",
    "connection defers the render to request time with the function this version documents in its place",
  ),
  "functions/io": replacingNoStore(
    true,
    "these import unstable_noStore, and under cacheComponents the documentation prefers io over connection",
    "io marks one read as request-time without giving up the prerender around it",
  ),
  "functions/cacheLife": cachedWithout(
    "cacheLife",
    "these cache scopes inherit the default profile because they never set one",
    "a profile sets how long the scope is fresh and how long it may be served stale, instead of the framework's default",
  ),
  "functions/cacheTag": cachedWithout(
    "cacheTag",
    "these cache scopes carry no tag, so nothing can invalidate them selectively",
    "a tag lets revalidateTag drop exactly these scopes, so a change reaches the page without waiting out the profile",
  ),
  // Without cacheComponents the extended fetch is what the documentation gives this shape; with
  // the flag the cache directive carries it, and each predicate reads the flag before the file.
  "functions/fetch": (context) =>
    context.isFlagEnabled("cacheComponents")
      ? NO_MATCH
      : evidenceOf(
          plainServerFetches(context),
          PLAIN_FETCH_NOTE,
          "the next option sets a revalidation window and tags on the call, so the response is reused between requests instead of fetched again on each one",
        ),
  "functions/generate-metadata": (context) => {
    const pages = pagesThatCannotVaryTheirTitle(context);
    return pages.length === 0
      ? NO_MATCH
      : suggest(
          pages,
          "these pages sit under a dynamic segment and state no metadata, and no layout above them states any either",
          "the function receives the resolved params, so the title and description can name the entity the URL does instead of repeating one line for every value the segment takes",
        );
  },
  "functions/generate-viewport": (context) => {
    const files = metadataObjectsCarryingViewport(context);
    return files.length === 0
      ? NO_MATCH
      : suggest(
          files,
          "these metadata objects still carry a viewport field, which the framework documents as moved out of metadata",
          "the viewport export is where the framework reads these three now, and it can be generated per route rather than fixed in the metadata object",
        );
  },
  "functions/generate-static-params": (context) => {
    const nodes = dynamicPagesWithoutStaticParams(context);
    const pages = nodes.flatMap((node) =>
      node.conventions.filter((c) => c.name === "page").map((c) => c.file),
    );
    return pages.length === 0
      ? NO_MATCH
      : suggest(
          pages,
          "these dynamic routes render on demand instead of being prerendered",
          "the params it returns are rendered at build time and served as static HTML, with the rest still rendered on demand",
        );
  },
};

/** Server actions that mutate without invalidating anything the client is showing. */
function serverActionsWithoutInvalidation(context: PredicateContext): SourceFileRecord[] {
  return serverActionFiles(context).filter(
    (file) => !INVALIDATION_SYMBOLS.some((symbol) => callsSymbol(file, "next/cache", symbol)),
  );
}

/**
 * The entry that carries the family's one suggestion. The other three delegate to it: they share
 * one condition and one sentence, so four entries reporting it is one fact counted four times.
 */
const INVALIDATION_CARRIER = "functions/revalidateTag";

/**
 * The segment hooks are one question with two answers — one level down, or all of them — and the
 * code that would argue for either is the same code. The singular carries the condition because
 * its page is the one the plural's links to, and the plural delegates rather than repeating the
 * finding over the same files.
 */
const SEGMENT_CARRIER = "functions/use-selected-layout-segment";

/**
 * Factual rather than diagnostic, and it has to be: whether a server action mutates anything needs
 * data flow this does not have. The condition observes one thing — a file declaring the server
 * directive that imports none of the four invalidation functions — and the sentence says that and
 * stops.
 *
 * It used to add "so any mutation in them leaves the UI stale", which asserts the mutation the
 * reading never established. `aurorascharff/next16-commerce` was told it of `auth-actions.ts`,
 * whose `logIn` and `logOut` read with `prisma.account.findFirst` and set a cookie: nothing there
 * mutates cached data, so nothing there was stale. The gain carries the conditional instead, which
 * is where a reader can weigh it against their own file.
 */
const INVALIDATION_NOTE = "these server action files import none of the invalidation functions";
const INVALIDATION_GAIN =
  "where one of them writes something a cache holds, an invalidation call after the write makes the next request read fresh data instead of the copy the client is still showing";

/**
 * Conditions that were measured against the fixtures and came back empty. They are abstentions
 * rather than backlog: the argument was tried.
 */
const MEASURED_AND_DROPPED: Readonly<Record<string, string>> = {
  // The helper parses a header the code reads by name, and reading it is the only observable
  // half. What a project does with the parse — a device branch, a bot check, a log line — is the
  // half that would say whether the parse is wanted, and it is not in the shape of the read.
  "functions/userAgent":
    "reading the user-agent header by name is one line, and whether the value is then parsed or passed through is a decision about what the code does with it, not something the read states",
  // A try/catch around a call that can throw a framework signal is the shape, and reading it needs
  // to know what the call throws. That is the callee's business, in the callee's file.
  "functions/unstable_rethrow":
    "whether a caught error can be a framework signal is a property of what the try block calls, which lives in the file that defines it and not in the one that catches",
  "functions/catchError":
    "a third-party error boundary is an ordinary component import, and no shape in the import separates one that catches renders from any other component a file brings in",
  "functions/draft-mode":
    "whether a project previews unpublished content is a product decision its code cannot argue for",
  // The helper returns several images from one convention file. The argument for it is that one
  // image is not enough, and how many a route needs is not a property of the file that generates
  // them — the same reason `generate-sitemaps` abstains beside it.
  "functions/generate-image-metadata":
    "how many versions of an image a route needs is a decision about the images, and a convention file generating one says nothing about whether a second is wanted",
  "functions/generate-sitemaps":
    "splitting a sitemap depends on how many entries it returns, and the tool reads no returned value",
  "functions/use-report-web-vitals":
    "where the metrics should go is the argument for reading them, and a destination — an analytics endpoint, a log, a dashboard — is not something a source tree names",
  "functions/after":
    "whether work belongs after the response is a decision about that work, not something its shape shows",
  "functions/cookies":
    "reading a cookie is what a feature needs or does not; no structure argues for it",
  "functions/redirect":
    "where a route should send a visitor is the product, not a property of the code",
  "functions/permanentRedirect":
    "whether a redirect is permanent is a decision about the URL, and the code says nothing about it",
  "functions/not-found":
    "whether a route can fail to find something is what it does; the not-found convention carries the argument that exists",
  "functions/image-response":
    "generating an image is a choice about the image, and no code shape distinguishes projects that want one",
  "functions/next-request":
    "the typed request is reached for by handlers that need it, and needing it is not observable",
  "functions/use-link-status":
    "showing pending state is a design decision, and nothing marks a link that should have one",
  "functions/use-params":
    "reading a route parameter on the client is what a component needs or does not",
  "functions/use-router": "navigating programmatically is what a component does or does not do",
  "functions/use-search-params": "reading the query string is what a component needs or does not",
  "functions/use-pathname":
    "reading the current path is what a component needs or does not; no structure argues for it",
  "functions/next-response":
    "returning a plain Response is valid, and the convenience methods are reached for by handlers that need them — the same reason next-request abstains",
  "functions/headers":
    "reading a request header is what a feature needs or does not; no structure argues for it, the way none argues for reading a cookie",
  // The helpers reach a root-level parameter without threading it down. The shape would be a
  // parameter passed through components that do not use it, which is a chain of files and not one.
  "functions/next-root-params":
    "the argument is a root parameter threaded through components that do not use it, and following a prop from where it is read to where it was declared is a chain of files rather than one",
  "functions/use-offline":
    "whether an application should render differently with no connection is a product decision, and no shape in a component says it wants one",
  // Both interrupt a render to mount `forbidden.tsx` or `unauthorized.tsx`. A route handler
  // answering by hand is doing the right thing — there is no UI to mount — so the shape would have
  // to be found inside a render, and inside a render it is an ordinary branch.
  "functions/forbidden":
    "inside a render the hand-rolled equivalent is a branch over a value the file does not define, returning ordinary elements; nothing in that shape separates a denial from any other condition, and a route handler answering 403 has no render to interrupt",
  "functions/unauthorized":
    "inside a render the hand-rolled equivalent is a branch over a value the file does not define, returning ordinary elements; nothing in that shape separates a denial from any other condition, and a route handler answering 401 has no render to interrupt",
};

/**
 * Entries whose suggestion is written and lives on another entry. `unwritten` would say nobody
 * has looked, when the condition exists and the reader can be pointed at it.
 *
 * `unstable_noStore` is argued for by the entry naming its replacement, and which entry that is
 * depends on `cacheComponents` — `io` under it, `connection` without. The pointer is static and
 * resolved against the derived surface, so it names `connection`: 16.2.6 documents no `io` page,
 * and `connection` is what the condition itself selects when the flag is unresolved.
 */
const DELEGATES_TO: Readonly<Record<string, string>> = {
  "functions/unstable_noStore": "functions/connection",
  // Its recorded reason was never an abstention but a delegation wearing one: *its replacement is
  // what a project should reach for, and the cache directive entry already argues that*. A
  // condition here would report the files that entry already reports, which is the shape the
  // corpus suite refuses — one fact counted twice.
  "functions/unstable_cache": "directives/use-cache",
  // One fact, one suggestion. All four invalidation functions share `serverActionsWithoutInvalidation`
  // and its one sentence, so before this each reported the same finding over the same files: four
  // times over one real project, thirty files each. A reader counting suggestions was counting one
  // fact four times, in the figure the report exists to make honest.
  //
  // `revalidateTag` carries it because the corpus register already named it the family's
  // representative, and a second representative would be a second answer to one question. The
  // bundled documentation was read before choosing: none of the four requires `cacheComponents`, so
  // every project can reach the carrier. `updateTag` and `refresh` are Server-Action-only where the
  // other two also work in a Route Handler, which is a reason to prefer the general one and not a
  // reason any project is excluded — the condition reads server action files either way.
  // One shape, and the two hooks differ only in how much of it they return: one segment or all of
  // them below the layout. The condition reads neither, so it argues for the pair, and the entry
  // documented by both supported versions carries it.
  "functions/use-selected-layout-segments": SEGMENT_CARRIER,
  "functions/revalidatePath": INVALIDATION_CARRIER,
  "functions/updateTag": INVALIDATION_CARRIER,
  "functions/refresh": INVALIDATION_CARRIER,
};

/**
 * A function with no would-apply condition. Most are tools a project reaches for when it needs
 * them, and nobody has written down what "needing them" looks like in code — which is a backlog,
 * not a decision, so it is named as one.
 *
 * An entry whose abstention was reopened never reaches here: the builder gives it a condition
 * instead of a reason, and the sentence it used to answer with travels on `reopenedFrom` through
 * the function above. The map keeps the sentence either way, which is what makes the carrier
 * verbatim rather than copied.
 */
/**
 * The abstention an entry answered with, carried onto the predicate that replaced it.
 *
 * Read out of the map above rather than retyped beside the predicate. Two dozen hand-copied
 * sentences is two dozen chances to paraphrase one, and the carrier promises verbatim — so the
 * sentence never moves and the predicate points at it.
 *
 * Throws for an id the map does not hold. A conversion naming an entry nobody abstained for is a
 * reopening of something that was never closed, and failing at load is where that belongs.
 */
export function reopenedFrom(id: string): ReopenedFrom {
  const why = MEASURED_AND_DROPPED[id];
  if (why === undefined) throw new Error(`no recorded abstention for ${id}`);
  return { from: id, why };
}

export function reasonFor(id: string): NoSuggestion {
  const delegate = DELEGATES_TO[id];
  if (delegate !== undefined) return { kind: "delegated", to: delegate, measuredAgainst: "16.3.0" };
  const measured = MEASURED_AND_DROPPED[id];
  return measured === undefined
    ? { kind: "unwritten", why: "no condition written for reaching for this function" }
    : { kind: "abstained", why: measured, measuredAgainst: "16.3.0" };
}

/**
 * The conditions written for the product abstentions, every one of them replacing an
 * abstention and every one behind `--strict`. The objection each replaced travels on the predicate
 * through `reopenedFrom`, read out of `MEASURED_AND_DROPPED` rather than retyped here.
 */
const WOULD_APPLY_STRICT: Readonly<Record<string, SuggestionPredicate>> = {
  "functions/unstable_rethrow": catchesReachingASignalThrower,
  "functions/next-root-params": rootParamsThreadedDown,
  "functions/catchError": boundariesUnderTheErrorConvention,
  "functions/use-router": (context) =>
    evidenceOfPaths(
      clientFilesWriting(context, navigatesByHand),
      "these navigate by assigning the URL or pushing onto the history stack",
      "the router navigates within the app, so the client keeps its state and the framework prefetches what it is about to render",
    ),
  "functions/use-pathname": (context) =>
    evidenceOfPaths(
      clientFilesWriting(context, (access) => access.path === "location.pathname"),
      "these read the current path off the browser's own object",
      "the hook returns the path the framework is rendering, so the value updates on navigation instead of being read once",
    ),
  "functions/use-search-params": (context) =>
    evidenceOfPaths(
      clientFilesWriting(context, (access) => access.path === "location.search"),
      "these take the query string apart off the browser's own object",
      "the hook returns the parsed parameters the framework is rendering, and updates them on navigation without the string being re-read",
    ),
  "functions/userAgent": (context) =>
    evidenceOfPaths(
      parsesTheUserAgent(context),
      "these read the user-agent header by name and match the value against something written here",
      "the helper returns the parse already made — device, browser, bot — so the match is against a field rather than against the raw string",
    ),
  "functions/after": (context) =>
    evidenceOfPaths(
      serverModulesDroppingPromises(context),
      "these start work and return without waiting for it",
      "the helper runs the work after the response is sent, so it is neither dropped nor holding the response open",
    ),
  "functions/next-request": (context) =>
    evidenceOfPaths(
      routeHandlerFiles(context)
        .filter((file) => file.parsesRequestUrl && !callsSymbol(file, "next/server", "NextRequest"))
        .map((file) => file.path)
        .sort(),
      "these handlers take the request URL apart by hand",
      "the typed request carries the parsed URL and the cookies already, so the handler reads a field instead of building a parser",
    ),
  "functions/next-response": (context) =>
    evidenceOfPaths(
      routeHandlerFiles(context)
        .filter(
          (file) => file.jsonResponses > 0 && !callsSymbol(file, "next/server", "NextResponse"),
        )
        .map((file) => file.path)
        .sort(),
      "these handlers build a JSON response by stringifying it themselves",
      "the helper serialises and sets the content type in one call, and carries the cookie and redirect helpers the handler would otherwise write out",
    ),
  "functions/redirect": (context) =>
    evidenceOfPaths(
      redirectsByHand(context, 307),
      "these build a temporary redirect response by hand, outside a route handler",
      "the function interrupts the render and redirects, so the caller returns nothing and the framework answers",
    ),
  "functions/permanentRedirect": (context) =>
    evidenceOfPaths(
      redirectsByHand(context, 308),
      "these build a permanent redirect response by hand, outside a route handler",
      "the function interrupts the render with the permanent status, which is the one a client and a crawler cache",
    ),
  /**
   * A route answering a missing record with a status literal rather than with the function.
   *
   * The overlap with `uncaughtNotFoundInHelpers` was checked before this was written, and there is
   * none by construction: that condition reports files that *call* the function where no convention
   * catches it, and this reports files that do not call it at all. The two file sets cannot
   * intersect, so the entry carries a condition rather than a delegation.
   */
  "functions/not-found": (context) =>
    evidenceOfPaths(
      routeHandlerFiles(context)
        .concat(
          productionFiles(context.sources).filter((file) =>
            conventionFiles(context, "page").has(file.path),
          ),
        )
        .filter(
          (file) =>
            file.statusValues.includes(404) && !callsSymbol(file, "next/navigation", "notFound"),
        )
        .map((file) => file.path)
        .sort(),
      "these answer a missing record with a 404 written out by hand",
      "the function interrupts the render and mounts the not-found convention, so the segment's own layout and UI answer instead of a bare status",
    ),
  "functions/forbidden": adoptedOnlyTheOtherInterrupt("unauthorized", "forbidden"),
  "functions/unauthorized": adoptedOnlyTheOtherInterrupt("forbidden", "unauthorized"),
  "functions/use-params": (context) => paramsThreadedToTheClient(context),
  "functions/cookies": absentEverywhere(
    "next/headers",
    "cookies",
    "nothing in this project reads a cookie",
    "the function reads the request's cookies in a Server Component or a Route Handler, without the value being threaded down from a boundary",
  ),
  "functions/headers": absentEverywhere(
    "next/headers",
    "headers",
    "nothing in this project reads a request header",
    "the function reads the request's headers on the server, so a value the client cannot see is available where the page is rendered",
  ),
  "functions/draft-mode": absentEverywhere(
    "next/headers",
    "draftMode",
    "nothing in this project enables a draft mode",
    "the function switches a request to uncached rendering, so unpublished content can be previewed on the same routes that serve the published copy",
  ),
  "functions/use-link-status": absentEverywhere(
    "next/link",
    "useLinkStatus",
    "no link in this project shows the framework's own pending state",
    "the hook reports whether the navigation a link started is still in flight, without the component tracking it",
  ),
  "functions/use-offline": absentEverywhere(
    "next/navigation",
    "useOffline",
    "nothing in this project reads whether the browser is offline",
    "the hook reports the connection the framework is already tracking, so a component can render differently without listening for the browser event itself",
  ),
  "functions/use-report-web-vitals": absentEverywhere(
    "next/web-vitals",
    "useReportWebVitals",
    "nothing in this project reads the metrics the framework already measures",
    "the hook hands over the measurements the framework takes on every navigation, without a second measurement being written",
  ),
  "functions/generate-sitemaps": (context) =>
    evidenceOfPaths(
      conventionsMissingExport(context, "sitemap", "generateSitemaps"),
      "these sitemaps are generated as one file",
      "the generator splits a sitemap the framework then serves as several, which is what the reference asks for past its size limit",
    ),
  "functions/generate-image-metadata": (context) =>
    evidenceOfPaths(
      imageConventionFiles(context).filter((path) => {
        const record = context.sources.byPath.get(path);
        return record !== undefined && !record.exportedNames.includes("generateImageMetadata");
      }),
      "these image conventions generate one image",
      "the generator returns several from one convention file, each with its own size and identifier",
    ),
  "functions/image-response": (context) =>
    evidenceOfPaths(
      imageConventionFiles(context).filter((path) => !context.sources.byPath.has(path)),
      "these image conventions are shipped as static files rather than generated",
      "the helper renders the image from JSX at request time, so it can name what the route is about instead of being one fixed asset",
    ),
};

/**
 * A client component reading a route parameter, reached from a convention file through a module
 * that passes it on.
 *
 * Not a restatement, and it is the one entry of its rank that is not: it cites a chain rather than
 * an absence. The objection — *reading a route parameter on the client is what a component needs or
 * does not* — is about the read, and this reports the threading instead.
 */
function paramsThreadedToTheClient(context: PredicateContext): Suggestion {
  const conventions = conventionFilePaths(context);
  if (conventions.size === 0) return NO_MATCH;
  const root = context.project.root;
  const found = new Set<string>();
  for (const file of productionFiles(context.sources)) {
    if (!file.readsRouteParams || !context.graph.clientClosure.has(file.path)) continue;
    if (conventions.has(file.path)) continue;
    for (const [, chain] of reaching(context.graph, conventions, file.path)) {
      if (chain.length < 3) continue;
      found.add(chain.map((path) => relative(root, path)).join(" → "));
    }
  }
  return found.size === 0
    ? NO_MATCH
    : suggest(
        [...found].sort(),
        "these client components read a route parameter passed down to them through another module",
        "the hook reads the parameters where the component is, so the modules in between stop carrying a prop none of them uses",
      );
}

/** Evidence already reduced to paths, for the conditions that filter rather than collect files. */
function evidenceOfPaths(paths: readonly string[], note: string, gain: string): Suggestion {
  return paths.length === 0 ? NO_MATCH : suggest(paths, note, gain);
}

/**
 * The conditions whose whole content is that the project does not use the API.
 *
 * Written because the owner asked for a condition on every entry, and marked because writing one
 * does not make it argue: restated as a suggestion each says *this exists and you are not using
 * it*, which is the Used bucket read backwards. The mark is what makes the decision reviewable —
 * the report counts them, and assembly refuses to promote one.
 *
 * `use-params` is not here, and it is the one entry of its rank that is not: it cites a chain of
 * files rather than an absence.
 */
const RESTATES_USED: ReadonlySet<string> = new Set([
  "functions/cookies",
  "functions/draft-mode",
  "functions/generate-image-metadata",
  "functions/generate-sitemaps",
  "functions/headers",
  "functions/image-response",
  "functions/use-link-status",
  "functions/use-offline",
  "functions/use-report-web-vitals",
]);

/** The three entries whose condition reads how the files reference each other, and the one before
 * them that already did. Declared per id, which is the pattern the segment hook set. */
const GRAFO_CONDITIONS: ReadonlySet<string> = new Set([
  SEGMENT_CARRIER,
  "functions/unstable_rethrow",
  "functions/next-root-params",
  "functions/catchError",
  "functions/use-params",
  // The client closure is what selects their files, so the evidence comes from the graph.
  "functions/use-router",
  "functions/use-pathname",
  "functions/use-search-params",
]);

/**
 * Conditions reading the graph only to remove server-side candidates a single read selected: the
 * client side of the boundary, and what nothing the framework loads reaches. See
 * `conditionCostNarrows` for why that reading may run under the default preset.
 */
const NARROWING_CONDITIONS: ReadonlySet<string> = new Set([
  "functions/fetch",
  "functions/after",
  "functions/redirect",
  "functions/permanentRedirect",
]);

export const FUNCTION_PREDICATES: readonly PredicateSet[] = Object.keys(FUNCTION_SHAPES).map(
  (id): PredicateSet => {
    // Only the carrier argues it. The rest of the family delegates, so the finding is reported
    // once rather than once per function that could have answered it.
    const wouldApply =
      id === INVALIDATION_CARRIER
        ? (context: PredicateContext): Suggestion =>
            evidenceOf(
              serverActionsWithoutInvalidation(context),
              INVALIDATION_NOTE,
              INVALIDATION_GAIN,
            )
        : WOULD_APPLY[id];

    const requiredFlag = REQUIRED_FLAG[id];
    const gate = requiredFlag === undefined ? {} : { requiredFlag };
    // Every used detection in this domain is `importedFrom(...)`, matched against one file's
    // imports, so the tier every run pays here is `AST` without exception. The graph is read by
    // twelve conditions, four of them only to narrow, and a condition's reading is declared in the
    // field for it: naming the set by it would tell a reader that used detection walks the module
    // graph, which none here does. Chosen per id rather than for the domain, because it is a
    // statement about one condition and not about where the entry lives.
    const cost = "AST" as const;
    const conditionTier = NARROWING_CONDITIONS.has(id)
      ? { conditionCost: "GRAFO" as const, conditionCostNarrows: true as const }
      : GRAFO_CONDITIONS.has(id)
        ? { conditionCost: "GRAFO" as const }
        : {};

    // A layout rendering a pathname reader is the arrangement the hook exists for, but the import
    // does not say the component reads it to find the active section, so the condition is observed.
    if (id === SEGMENT_CARRIER) {
      return {
        id,
        cost,
        ...conditionTier,
        ...gate,
        detectUsed,
        wouldApplyStrict: pathnameReadersUnderALayout,
      };
    }

    // An abstention reopened. The condition is withheld, and the sentence the entry used to answer
    // with travels on it rather than being deleted by the conversion.
    const reopened = WOULD_APPLY_STRICT[id];
    if (reopened !== undefined) {
      // The dismissal survives the conversion. An entry the framework rules out is ruled out
      // whatever condition it now carries, and dropping it here would offer an API to a project
      // that has nothing for it to act on.
      const dismissal = NOT_APPLICABLE[id];
      return {
        id,
        cost,
        ...conditionTier,
        ...gate,
        detectUsed,
        ...(dismissal === undefined ? {} : { notApplicable: dismissal }),
        wouldApplyStrict: reopened,
        reopenedFrom: reopenedFrom(id),
        ...(RESTATES_USED.has(id) ? { restatesUsed: true as const } : {}),
      };
    }

    if (wouldApply === undefined) {
      const notApplicable = NOT_APPLICABLE[id];
      return notApplicable === undefined
        ? { id, cost, ...gate, detectUsed, noSuggestion: reasonFor(id) }
        : { id, cost, ...gate, detectUsed, notApplicable, noSuggestion: reasonFor(id) };
    }

    // Whether a server action mutates needs data flow we do not have, so its heuristic is
    // observed rather than proven and stays out of the default preset.
    // Spread only on the branches that carry a condition: assembly refuses a condition's tier on a
    // set with none, so the branch above with no condition must not receive it.
    return id === INVALIDATION_CARRIER
      ? { id, cost, ...conditionTier, ...gate, detectUsed, wouldApply, wouldApplyPreset: "strict" }
      : { id, cost, ...conditionTier, ...gate, detectUsed, wouldApply };
  },
);
