import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  argumentsOf,
  type CallArgument,
  type CallRecord,
  fetchCacheOf,
  fetchTagsOf,
  fileConstants,
  importedLocalNames,
  literalArgument,
  optionTagsOf,
} from "./calls.js";
import { type ClientDirectiveReasons, clientDirectiveReasons } from "./client-reasons.js";
import { unversionedDirectories } from "./ignored.js";
import {
  collectJsx,
  isTestFile,
  type JsxElementRecord,
  type LintSuppressions,
  readLintSuppressions,
} from "./jsx.js";
import {
  declaredPackagesAt,
  packageGlobs,
  packageNameAt,
  readPackageJson,
  resolveWorkspaceRoot,
} from "./project.js";
import { createResolver, type Declared, type ModuleResolution, type Resolver } from "./resolve.js";

export type { CallArgument, CallRecord } from "./calls.js";
export type { ClientDirectiveReasons } from "./client-reasons.js";
// Read here and by the discovery that looks below a root declaring nothing, so it lives in a module
// neither of them imports. Re-exported because the scan is where every caller already looks for it.
export { unversionedDirectories } from "./ignored.js";
export type { ModuleResolution, Resolver } from "./resolve.js";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

const CLIENT_DIRECTIVE = "use client";

/**
 * The floor: skipped whatever the project says, because a project may commit no `.gitignore` and
 * `node_modules` still is not its code. Not the mechanism — see `unversionedDirectories`.
 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", "dist", "build", "coverage", "out"]);

/** Whether `path` is a directory that sits under `root` rather than beside or above it. */
function directoryUnder(root: string, path: string): boolean {
  const inside = relative(root, path);
  if (inside === "" || inside.startsWith("..")) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The workspace packages that are not the application, as absolute directories.
 *
 * A package the project declares as its own workspace member carries its own manifest and its own
 * dependencies, so resolving its imports against the application's manifest reports packages the
 * application does not have about code that never claimed it did.
 *
 * The manifest decides, not the directory. A package declaring `next` is App Router surface
 * wherever it sits and stays scanned — dropping a `packages/ui` full of components importing
 * `next/image` would delete real adoption, which is the expensive failure. A package declaring no
 * `next` cannot adopt an App Router API, so scanning it buys nothing.
 *
 * Two glob shapes are read, `dir` and `dir/*`, and everything else is refused: a refused glob skips
 * nothing, which is the behaviour before this reading existed. Only the records at the analysed
 * root are read, and this does not claim the boundary is complete.
 */
/**
 * Every workspace member the declaration names, as absolute directories.
 *
 * Read from the workspace root rather than the analysed project: a monorepo declares its members at
 * the repository root, and an app several directories below it sees no declaration at all.
 */
function workspaceMembers(workspaceRoot: string): string[] {
  const members: string[] = [];
  for (const glob of packageGlobs(workspaceRoot)) {
    if (!glob.endsWith("/*")) {
      members.push(resolve(workspaceRoot, glob));
      continue;
    }
    const parent = resolve(workspaceRoot, glob.slice(0, -2));
    for (const entry of safeReadDir(parent)) {
      if (entry.isDirectory()) members.push(join(parent, entry.name));
    }
  }
  return members;
}

/**
 * The workspace members this project links to, by the name each one calls itself.
 *
 * Retention is by dependency rather than by what a member's own manifest declares. The old reading
 * kept a member that declared `next` and dropped every other, which is two errors at once: a plain
 * library the app depends on was unreachable — `Asymmetric-al/core`'s `apps/admin` calls `cookies()`
 * through `packages/db`, and the entry read as unused — and a sibling Next app the project has
 * nothing to do with was scanned as though it were part of it.
 *
 * A member with no readable manifest, or one whose name the project does not depend on, is not
 * linked here. Nothing is guessed from directory layout: the manifest names the package, and the
 * dependency list says whether this project uses it.
 */
export function linkedPackages(projectRoot: string): ReadonlySet<string> {
  const workspaceRoot = resolveWorkspaceRoot(projectRoot);
  if (workspaceRoot === undefined) return new Set();
  const dependencies = declaredPackagesAt(projectRoot);
  if (dependencies === undefined) return new Set();

  const linked = new Set<string>();
  for (const directory of workspaceMembers(workspaceRoot)) {
    if (directory === projectRoot) continue;
    const name = packageNameAt(directory);
    if (name !== undefined && dependencies.has(name)) linked.add(directory);
  }
  return linked;
}

/**
 * Workspace members under this project that it does not link to.
 *
 * A sibling the project does not depend on is somebody else's code sitting in the same tree, and
 * walking into it attributes its files to this project. Only members *under* the project root can
 * be pruned this way — a member elsewhere in the monorepo is never walked into to begin with.
 */
export function foreignPackages(root: string): ReadonlySet<string> {
  const linked = linkedPackages(root);
  const workspaceRoot = resolveWorkspaceRoot(root);
  const foreign = new Set<string>();
  for (const directory of workspaceMembers(workspaceRoot ?? root)) {
    if (directory === root || linked.has(directory)) continue;
    if (directoryUnder(root, directory)) foreign.add(directory);
  }
  return foreign;
}

/**
 * The directories the project's own TypeScript program excludes, as absolute paths.
 *
 * A project that keeps a directory out of its own typecheck has stated that the directory is not
 * the program it maintains. One project excludes `types/appsync/graphql`, generated AppSync
 * resolvers that take their imports from the AppSync runtime rather than from npm, and every
 * package this tool reported the project as missing came from there.
 *
 * Only `exclude` is read, and only its directory entries. The computed program is not used: this
 * project's `include` lists `**\/*.ts` and `**\/*.tsx` alone, so every `.js` the framework loads
 * would fall outside it. A file entry is ignored too — excluding `playwright.config.ts` from a
 * typecheck says nothing about whether the project owns it.
 *
 * The result is paths rather than names, because a tsconfig entry means that directory and no
 * other: a project excluding `infra` at its root must not silence an unrelated `app/infra`.
 */
export function excludedFromProgram(root: string): ReadonlySet<string> {
  const excluded = new Set<string>();
  const read = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (read.error !== undefined || read.config === undefined) return excluded;
  const entries: unknown = (read.config as { exclude?: unknown }).exclude;
  if (!Array.isArray(entries)) return excluded;
  for (const entry of entries) {
    if (typeof entry !== "string" || /[*?]/.test(entry)) continue;
    const path = resolve(root, entry);
    if (directoryUnder(root, path)) excluded.add(path);
  }
  return excluded;
}

/** Every directory the project's records place outside its application, as absolute paths. */
export function foreignDirectories(root: string): ReadonlySet<string> {
  return new Set([...foreignPackages(root), ...excludedFromProgram(root)]);
}

export type ImportBinding = {
  /** The name as exported by the module, or `default` / `*` for those forms. */
  readonly imported: string;
  readonly local: string;
  /** Importing a type is not using a value, so predicates must be able to tell. */
  readonly typeOnly: boolean;
};

/**
 * One reference from this file to another module, whatever syntax wrote it. A type-only reference
 * is kept and marked, never dropped: what it means depends on the question being asked, and only a
 * rule that follows imports at runtime should ignore it.
 */
export type ModuleReference = {
  readonly specifier: string;
  readonly kind: "import" | "reexport" | "dynamic";
  readonly typeOnly: boolean;
  readonly resolution: ModuleResolution;
};

/**
 * A directive that opens a scope, with the bare identifiers that scope's body calls. The body is
 * the whole subtree under it, so a call nested in an `if` inside the function still belongs to the
 * scope the function opened.
 */
export type CacheScopeRecord = {
  readonly directive: string;
  readonly calledIdentifiers: ReadonlySet<string>;
};

/**
 * A call reading a request body, with the name the receiver was written under. The receiver is
 * kept because the five method names are not the property of a request: `NextResponse.json` is the
 * commonest call in a proxy file, and a reading that recorded the method alone would report every
 * response built as a body that was read.
 */
/**
 * A property-access chain rooted at a global only a browser provides, with whether the file writes
 * to it. `window.` is dropped from the front, so `window.location.href` and `location.href` are one
 * fact: they are one fact to the runtime, and a reader looking for either wants both.
 */
export type GlobalAccess = {
  /** The chain, without a leading `window.` — `location.pathname`, `history.pushState`. */
  readonly path: string;
  /** Whether the chain is the target of an assignment rather than a value being read. */
  readonly assigned: boolean;
};

export type BodyRead = {
  /** The identifier the call was made on, exactly as the file spells it. */
  readonly receiver: string;
  readonly method: string;
};

export type SourceFileRecord = {
  readonly path: string;
  /** Directives in the file prologue, such as the client or cache directives. */
  readonly fileDirectives: readonly string[];
  /** Directives inside a function body, which scope to that function only. */
  readonly functionDirectives: readonly string[];
  readonly imports: ReadonlyMap<string, readonly ImportBinding[]>;
  /** Every module this file references, in source order, with where each specifier resolved to. */
  readonly moduleReferences: readonly ModuleReference[];
  readonly exportedNames: readonly string[];
  /**
   * The names this file exports as a type alias or an interface: the declarations the compiler
   * erases.
   *
   * Read positively, and never as the complement of `exportedNames`. That list holds functions,
   * variables and re-exports; a class or an export form it does not cover is absent from it while
   * being a value, so reading absence as "it must be a type" would erase edges the runtime has.
   */
  readonly exportedTypeNames: readonly string[];
  /**
   * Local names this file calls inside a `try` that has a `catch`.
   *
   * `catchClauses` says the file catches something somewhere. A finding that a catch swallows a
   * framework signal needs the call to be inside that catch, which is a different question: a file
   * may guard one call and reach a thrower through another, several statements away.
   *
   * A `try`/`finally` re-raises, so it is not counted. The name is the local one, because that is
   * what the call site wrote.
   */
  readonly calledUnderACatch: readonly string[];
  /**
   * The literal value of an exported `const`, by name, when the initialiser is one. A computed
   * initialiser is left out rather than guessed at: a route segment config option is only worth
   * reading when the value is written where the file can be seen.
   */
  readonly exportedLiterals: ReadonlyMap<string, string>;
  readonly hasDefaultExport: boolean;
  /**
   * Whether the default export is declared `async`, read from the declaration alone. An
   * identifier declared elsewhere or a re-export is not followed, so this under-reports
   * rather than guessing: the scan makes one parse per file.
   */
  readonly hasAsyncDefaultExport: boolean;
  /** Calls to `fetch` carrying a `next` option: the framework extension, not the platform API. */
  /**
   * Top-level key names of an exported object literal, by export name. Names only: a value is read
   * where a condition needs one, and the keys are what says which fields an object carries.
   *
   * An export whose initializer is not an object literal contributes nothing rather than an empty
   * list — an object assembled elsewhere carries keys nobody wrote down here.
   */
  readonly exportedObjectKeys: ReadonlyMap<string, readonly string[]>;
  /**
   * Whether the file reads the current path and compares it against one written down here. The
   * shape a layout computing its own position by hand holds, and what the segment hooks return
   * without it.
   */
  readonly comparesPathnameToLiteral: boolean;
  /**
   * Social image paths an exported `metadata` object names by hand, under `openGraph.images` or
   * `twitter.images`. Literals only: an image assembled from a variable is a path nobody wrote
   * down here.
   */
  readonly socialImagePaths: readonly string[];
  readonly extendedFetchCalls: number;
  /**
   * Calls to `fetch` stating nothing about their caching: no options argument, or one whose object
   * literal carries neither `cache` nor `next`. An options argument that is a variable or holds a
   * spread is not one of these — what it carries is not readable, and a call whose options nobody
   * wrote down is not a call that said nothing.
   */
  readonly plainFetchCalls: number;
  /** Bare identifiers this file calls. Recorded for future heuristics, never trusted alone. */
  readonly calledIdentifiers: ReadonlySet<string>;
  /**
   * The keys this file reads off `process.env`, by name. Literal accesses only: a read through a
   * variable names a key nobody wrote here, and a rule reporting one would name a key that does
   * not appear in the file.
   */
  readonly environmentReads: ReadonlySet<string>;
  /**
   * One record per directive that opens a scope, with what that scope's own body calls. A file-wide
   * list of directives cannot say which function carries which, and a rule that reads a directive
   * here and a call there reports a scope that does neither.
   */
  readonly cacheScopes: readonly CacheScopeRecord[];
  /** Calls to bare identifiers, with the arguments we were able to read. */
  readonly calls: readonly CallRecord[];
  /** Tags carried by the `next` option of a fetch call, in declaration order. */
  readonly fetchTags: readonly CallArgument[];
  /**
   * The `cache` value of each fetch call that passes one, in declaration order. Read apart from
   * the `next` option: a call may carry either without the other, and what each says is different.
   */
  readonly fetchCaches: readonly CallArgument[];
  /**
   * String literals the file assigns to a `src` property. A web app manifest declares its icons
   * this way, and reading them here costs one branch of a walk that already happens.
   */
  readonly srcValues: readonly string[];
  /**
   * String literals a `userAgent` property names. A `robots` convention writes its crawlers here,
   * as one string or as an array of them, and both shapes are read the same way.
   *
   * Literals only, like every other value read off this walk: an agent assembled from a variable
   * is a crawler nobody wrote down here, and a finding naming one would name a string absent from
   * the file it cites.
   */
  readonly userAgents: readonly string[];
  /**
   * Calls to the five methods that consume a request body, with the receiver each was made on.
   * Recorded for any receiver and filtered by the reader: what makes one of these a request body
   * is the name it was called on, and that is a judgement about the convention rather than about
   * the syntax.
   */
  readonly bodyReads: readonly BodyRead[];
  /**
   * Property-access chains this file writes on a browser global, and whether each is assigned to.
   *
   * The hand-rolled equivalents of the navigation hooks are all one of these: assigning
   * `location.href`, reading `location.pathname`, taking `location.search` apart. A rule wanting
   * one of them is asking about a chain rather than about the global, which `clientReasons` answers
   * with a single boolean.
   */
  readonly globalAccess: readonly GlobalAccess[];
  /**
   * How many `catch` clauses the file holds. A count rather than their contents: the rule that
   * needs this asks whether a file catches at all, and what it does with what it caught is the
   * half that rule reads elsewhere.
   */
  readonly catchClauses: number;
  /**
   * Calls to a function this file itself declares `async`, written as a statement and never
   * awaited.
   *
   * Locally declared, because that is what makes the promise readable: a call to an imported name
   * may return anything, and reporting one as a floating promise would be a guess about another
   * file. A call to a function whose own declaration carries `async` returns a promise by
   * construction.
   */
  readonly unawaitedLocalAsyncCalls: readonly string[];
  /**
   * String literals passed to a `.get(...)` call, lower-cased. A request header is read by name
   * through exactly this shape, and lower-casing it is what the platform does to the name anyway.
   */
  readonly getArguments: readonly string[];
  /** Whether the file writes a regular-expression literal, or calls `test`, `match` or `includes`. */
  readonly matchesAValue: boolean;
  /** Whether the file constructs a `URL` from the `url` property of a bare identifier. */
  readonly parsesRequestUrl: boolean;
  /** How many `Response` objects the file constructs from a `JSON.stringify` call. */
  readonly jsonResponses: number;
  /**
   * The status a response built by hand carries, read only where the file builds one.
   *
   * `status` is a generic property name — an order has one, a form has one, a workflow has one —
   * so a numeric literal under it says nothing on its own. Only the ones inside a `Response` or
   * `NextResponse` construction, or passed to either one's `redirect`, are a status a route
   * answers with.
   */
  readonly statusValues: readonly number[];
  /** Whether the file reads a property off something named `searchParams`. */
  readonly readsSearchParams: boolean;
  /** Whether the file reads a property off something named `params`: a route parameter, by name. */
  readonly readsRouteParams: boolean;
  readonly jsxElements: readonly JsxElementRecord[];
  /**
   * The ESLint rules this file turns off, file-wide and by line.
   *
   * A project's lint configuration is a decision it already made, so a condition arguing against a
   * rule the file disables is arguing with the author rather than telling them anything.
   */
  readonly lintSuppressions: LintSuppressions;
  /**
   * Which of the documented reasons for the client directive this file shows. Read only where the
   * file declares the directive: on any other file the question is about nobody's decision.
   */
  readonly clientReasons?: ClientDirectiveReasons;
  /** Suggestions ignore tests; use detection does not. */
  readonly isTest: boolean;
  /**
   * What places this file outside the Next.js server runtime, absent when nothing does.
   *
   * Absent is not a claim that the file runs on the server. It is the absence of a reason to think
   * otherwise, which is exactly what reading "not on the client" as "on the server" got wrong.
   */
  readonly runsElsewhere?: ElsewhereSignal;
  /**
   * A shebang, or a read of `process.argv`. Recorded rather than settled: a `next.config.ts` reads
   * `process.argv` too, and telling it from a script needs the route tree, which the scan runs
   * before. Settled in `placedElsewhere`.
   */
  readonly looksLikeAScript: boolean;
};

/** What a reading of a file placed it outside the Next.js server runtime. */
export type ElsewhereSignal =
  | "public-asset"
  | "service-worker"
  | "pages-router"
  | "node-script"
  | "tool-config";

/**
 * How the project's specifiers landed. Disclosed, so no closure built on them reads as complete.
 *
 * `unresolved` holds only what makes the walk incomplete: a specifier that should have named this
 * project's own code and did not. Assets and absent packages are counted apart because neither can
 * put code in the closure, and folding them in reported blindness the scan did not have.
 */
export type ResolutionCounts = {
  readonly internal: number;
  readonly external: number;
  readonly unresolved: number;
  /** Stylesheet references. Never code, so never a reason the boundary is a lower bound. */
  readonly assets: number;
  /** Packages the code imports and the project does not have, by name, each counted. */
  readonly missingPackages: readonly MissingPackage[];
};

export type MissingPackage = {
  readonly name: string;
  readonly declared: Declared;
  /** How many references name it, so one package imported everywhere is not read as many. */
  readonly references: number;
};

export type SourceIndex = {
  readonly files: readonly SourceFileRecord[];
  readonly byPath: ReadonlyMap<string, SourceFileRecord>;
  readonly resolution: ResolutionCounts;
  /**
   * Workspace members this project links to and the scan therefore read, and dependencies that
   * looked like a workspace link and matched no member.
   *
   * Disclosed because a reader cannot otherwise tell a project whose linked code was read from one
   * whose was not, and the difference decides whether an entry reporting nothing means the project
   * does not use the API or that the scan never opened the file that does.
   */
  readonly linked: {
    readonly scanned: number;
    /** Named as a workspace dependency and matched by no member the declaration lists. */
    readonly unmatched: number;
  };
};

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isSourceFile(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function findSourceFiles(root: string): string[] {
  const found: string[] = [];
  const unversioned = unversionedDirectories(root);
  const foreign = foreignDirectories(root);
  const skipped = (name: string): boolean => SKIPPED_DIRECTORIES.has(name) || unversioned.has(name);
  const seen = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of safeReadDir(dir)) {
      if (entry.isDirectory()) {
        const path = join(dir, entry.name);
        if (entry.name.startsWith(".") || skipped(entry.name) || foreign.has(path)) continue;
        walk(path);
        continue;
      }
      if (entry.isFile() && isSourceFile(entry.name)) {
        const path = join(dir, entry.name);
        if (!seen.has(path)) {
          seen.add(path);
          found.push(path);
        }
      }
    }
  };
  walk(root);
  // Each linked workspace member is a root of its own. Its files are this project's to read — an
  // app calling `cookies()` through a linked package is calling it — and a member outside the
  // project root is never reached by the walk above. The same pruning applies inside it, and a
  // member nested under the root is deduplicated rather than walked twice.
  for (const linked of linkedPackages(root)) walk(linked);
  // Sorted so the index never depends on filesystem enumeration order.
  return found.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/**
 * The bare identifiers called anywhere under a node. Bare only, the way the ledger reads calls: a
 * method call anchors on no import binding, so a name behind a dot is not one of these.
 */
function identifiersCalledIn(node: ts.Node): ReadonlySet<string> {
  const called = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
      called.add(child.expression.text);
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return called;
}

function directivesOf(statements: readonly ts.Statement[]): string[] {
  const directives: string[] = [];
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement)) break;
    const { expression } = statement;
    if (!ts.isStringLiteral(expression)) break;
    directives.push(expression.text);
  }
  return directives;
}

function bindingsOf(declaration: ts.ImportDeclaration): ImportBinding[] {
  const clause = declaration.importClause;
  if (!clause) return [];
  const clauseIsTypeOnly = clause.isTypeOnly;
  const bindings: ImportBinding[] = [];

  if (clause.name) {
    bindings.push({ imported: "default", local: clause.name.text, typeOnly: clauseIsTypeOnly });
  }
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    bindings.push({ imported: "*", local: named.name.text, typeOnly: clauseIsTypeOnly });
  }
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      bindings.push({
        imported: (element.propertyName ?? element.name).text,
        local: element.name.text,
        typeOnly: clauseIsTypeOnly || element.isTypeOnly,
      });
    }
  }
  return bindings;
}

/**
 * A reference is type-only when the declaration says so, or when every name it brings is a type.
 * Read from the syntax, never guessed from the names themselves.
 */
function importIsTypeOnly(declaration: ts.ImportDeclaration): boolean {
  const clause = declaration.importClause;
  // A side-effect import brings no names, and it is very much a runtime edge.
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const named = clause.namedBindings;
  if (!named || !ts.isNamedImports(named)) return false;
  return named.elements.length > 0 && named.elements.every((element) => element.isTypeOnly);
}

function reexportIsTypeOnly(declaration: ts.ExportDeclaration): boolean {
  if (declaration.isTypeOnly) return true;
  const clause = declaration.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

function isDynamicImport(call: ts.CallExpression): boolean {
  return call.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    : false;
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

/** `export default function P()` carries a name but is still the default export. */
function isDefaultExported(node: ts.Node): boolean {
  return isExported(node) && hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

/**
 * Whether an expression standing in for the default export is an async function. Only a function
 * written in place is read; an identifier resolves elsewhere and is left alone.
 */
function isAsyncFunctionExpression(node: ts.Expression): boolean {
  // `export default (async function () {})` is the same declaration wrapped in parentheses.
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  return (
    (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) &&
    hasModifier(inner, ts.SyntaxKind.AsyncKeyword)
  );
}

/** A `fetch(url, { next: ... })` call, which is the framework's extension of the global. */
/**
 * A `fetch` that states nothing about how its result is cached. The framework extends the call
 * with `next` and honours the platform's own `cache`; a call carrying neither is the shape the
 * extension exists for, and the entry that carries it is decided by `cacheComponents`.
 */
const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** String methods a path is matched with when it is not compared outright. */
const PATH_MATCHERS = new Set(["startsWith", "endsWith", "includes"]);

/**
 * Whether the file reads the current path and compares it against a path somebody wrote down.
 *
 * Three steps, all inside the file: the local name `usePathname` is bound to, the identifiers its
 * result is held in, and a comparison of one of those against a string literal. A pathname held in
 * no variable, or compared against a value from elsewhere, is not this shape — the hook returning a
 * string says nothing on its own, and it is the written-down path that makes the comparison a
 * segment the framework already knows.
 */
function comparesPathnameToLiteral(source: ts.SourceFile): boolean {
  let hook: string | undefined;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (statement.moduleSpecifier.text !== "next/navigation") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "usePathname") hook = element.name.text;
    }
  }
  if (hook === undefined) return false;

  const held = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === hook
    ) {
      held.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(source, collect);
  if (held.size === 0) return false;

  const isHeld = (node: ts.Node): boolean => ts.isIdentifier(node) && held.has(node.text);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      if (
        (isHeld(node.left) && ts.isStringLiteral(node.right)) ||
        (isHeld(node.right) && ts.isStringLiteral(node.left))
      ) {
        found = true;
      }
    }
    const [argument] = ts.isCallExpression(node) ? node.arguments : [];
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isHeld(node.expression.expression) &&
      PATH_MATCHERS.has(node.expression.name.text) &&
      argument !== undefined &&
      ts.isStringLiteral(argument)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/** The metadata containers whose `images` the social image conventions generate. */
const SOCIAL_CONTAINERS = new Set(["openGraph", "twitter"]);

/** The object literal behind an initializer, through an `as` or `satisfies` written around it. */
function objectLiteralOf(node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  if (node === undefined) return undefined;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return objectLiteralOf(node.expression);
  }
  return undefined;
}

/** Every string literal an `images` value writes down, whichever of its shapes it takes. */
function imageLiteralsOf(value: ts.Expression): string[] {
  if (ts.isStringLiteral(value)) return [value.text];
  const object = objectLiteralOf(value);
  if (object !== undefined) {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (!ts.isIdentifier(property.name) || property.name.text !== "url") continue;
      if (ts.isStringLiteral(property.initializer)) return [property.initializer.text];
    }
    return [];
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.flatMap((element) => imageLiteralsOf(element));
  }
  return [];
}

/**
 * Social image paths an exported `metadata` object names by hand: the string literals under
 * `openGraph.images` and `twitter.images`, in any of the shapes the framework accepts — a string,
 * an array of them, or objects carrying a `url`.
 *
 * Literals only. An image assembled from a variable is a path nobody wrote here, and the
 * convention that would replace it is argued for by the path being written down.
 */
function socialImagePathsOf(source: ts.SourceFile): readonly string[] {
  const found: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "metadata") continue;
      const metadata = objectLiteralOf(declaration.initializer);
      if (metadata === undefined) continue;
      for (const container of metadata.properties) {
        if (!ts.isPropertyAssignment(container)) continue;
        if (!ts.isIdentifier(container.name) || !SOCIAL_CONTAINERS.has(container.name.text)) {
          continue;
        }
        const inner = objectLiteralOf(container.initializer);
        if (inner === undefined) continue;
        for (const property of inner.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (!ts.isIdentifier(property.name) || property.name.text !== "images") continue;
          found.push(...imageLiteralsOf(property.initializer));
        }
      }
    }
  }
  return found;
}

/** Top-level property names an object literal writes down. A spread names nothing readable. */
function objectKeysOf(object: ts.ObjectLiteralExpression): readonly string[] {
  const names: string[] = [];
  for (const property of object.properties) {
    const { name } = property;
    if (name === undefined) continue;
    if (ts.isIdentifier(name)) names.push(name.text);
    else if (ts.isStringLiteral(name)) names.push(name.text);
  }
  return names;
}

/**
 * The method an options object writes down, lower-cased. `undefined` where none is written, and
 * `unreadable` where one is written as anything but a literal.
 */
function fetchMethodOf(options: ts.ObjectLiteralExpression): string | "unreadable" | undefined {
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (!propertyNameIs(property, "method")) continue;
    return ts.isStringLiteral(property.initializer)
      ? property.initializer.text.toLowerCase()
      : "unreadable";
  }
  return undefined;
}

/**
 * A fetch whose result nothing states a lifetime for. Read as the absence of `next` and `cache`,
 * and only on a call those options are about: the Data Cache is for what a request reads, so a
 * method that writes carries neither option because neither applies, not because the call said
 * nothing. A method written as an expression is a method nobody can read here, and a call whose
 * method is unknown is one this cannot claim is cacheable.
 */
function isPlainFetch(call: ts.CallExpression): boolean {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "fetch") return false;
  const options = call.arguments[1];
  if (options === undefined) return true;
  if (!ts.isObjectLiteralExpression(options)) return false;
  // A spread may carry either key, so the object no longer says what it holds.
  if (options.properties.some((property) => ts.isSpreadAssignment(property))) return false;
  const method = fetchMethodOf(options);
  if (method !== undefined && method !== "get") return false;
  return !options.properties.some(
    (property) =>
      property.name !== undefined &&
      ts.isIdentifier(property.name) &&
      (property.name.text === "next" || property.name.text === "cache"),
  );
}

/**
 * The key in a `process.env.NAME` read, or nothing. Written down rather than computed: an access
 * through a variable names a key this cannot resolve, and reporting one it guessed at is the
 * failure every reader here is built to avoid.
 */
function environmentKeyOf(node: ts.PropertyAccessExpression): string | undefined {
  const { expression, name } = node;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "process") {
    return undefined;
  }
  return expression.name.text === "env" ? name.text : undefined;
}

/**
 * The methods that consume a request body. The set the framework's own proxy page writes, and the
 * whole of it: a body is read once, and which of the five did it decides nothing about the limit.
 */
const BODY_READERS = new Set(["text", "json", "formData", "arrayBuffer", "blob"]);

/** The body-reading call this node is, or nothing. Only a call on a bare identifier is read. */
function bodyReadOf(call: ts.CallExpression): BodyRead | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (!BODY_READERS.has(callee.name.text)) return undefined;
  return ts.isIdentifier(callee.expression)
    ? { receiver: callee.expression.text, method: callee.name.text }
    : undefined;
}

/** Every string a `userAgent` property names, whether it is written as one or as an array. */
function userAgentLiteralsOf(value: ts.Expression): string[] {
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return [value.text];
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.flatMap((element) => userAgentLiteralsOf(element));
  }
  return [];
}

function isExtendedFetch(call: ts.CallExpression): boolean {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "fetch") return false;
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (property) =>
      property.name !== undefined &&
      ts.isIdentifier(property.name) &&
      property.name.text === "next",
  );
}

/**
 * The globals whose members these rules read. Only the ones a browser provides and a server does
 * not: a chain rooted anywhere else is this project's own object, and its shape says nothing about
 * an API the framework offers.
 */
const BROWSER_ROOTS = new Set(["window", "location", "history", "document", "navigator"]);

/** The dotted chain a property access spells, or nothing where its root is not an identifier. */
function chainOf(
  node: ts.PropertyAccessExpression,
  shadowed: ReadonlySet<string>,
): string | undefined {
  const parts: string[] = [node.name.text];
  let current: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return undefined;
  parts.unshift(current.text);
  // `window.` is dropped so the two spellings of one fact read as one.
  if (parts[0] === "window" && parts.length > 1) parts.shift();
  const root = parts[0];
  if (root === undefined || !BROWSER_ROOTS.has(root) || shadowed.has(root)) return undefined;
  return parts.join(".");
}

/** Whether this node is the left-hand side of an assignment. */
function isAssignedTo(node: ts.Node, parent: ts.Node | undefined): boolean {
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/** The two names a route receives its own dynamic segments and query string under. */
const ROUTE_PROP_NAMES = new Set(["params", "searchParams"]);

/**
 * What one walk over the file's bindings settles: the browser roots it shadows, and the route prop
 * names it binds to something the router did not give it.
 *
 * One walk rather than two. Both questions are about the same declarations — a parameter, a
 * variable, a binding element, an import — and a second pass over every AST in the project measured
 * 40% onto the scan of a thousand-file project, for a question the first pass was already at the
 * right node to answer.
 *
 * **Shadowed roots.** A file writing `const location = { pathname: '/a' }` and reading
 * `location.pathname` is reading its own object, and a rule reporting it would name a hand-rolled
 * equivalent in a file that has none.
 *
 * **Disqualified route props.** Three shapes are the router's own, and they are the ones the
 * documentation writes: the prop as a parameter, a name destructured out of a parameter's object
 * pattern, and a local bound to an `await` — which is how a page reads the promise both props now
 * arrive as. Every other binding of the name is the file's own. The reading these gate was written
 * on the name alone, so `const params = new URLSearchParams(); params.append(…)` — ordinary
 * JavaScript — had a real starter's query-string builder reported through a three-file import chain
 * as a client component reading a route parameter.
 *
 * Both drop the whole name for the file rather than tracking the one declaration: a file that both
 * shadows and uses reports nothing, which is the direction this scan errs in everywhere else.
 *
 * The walk carries whether it is inside a binding the router supplied rather than reading `parent`
 * off a node: these trees are parsed without parent pointers, and asking for one is undefined.
 */
function fileBindings(source: ts.SourceFile): {
  readonly shadowedRoots: ReadonlySet<string>;
  readonly disqualifiedRouteProps: ReadonlySet<string>;
} {
  const shadowedRoots = new Set<string>();
  const disqualifiedRouteProps = new Set<string>();
  const bind = (name: ts.Node, fromRoute: boolean): void => {
    if (!ts.isIdentifier(name)) return;
    if (BROWSER_ROOTS.has(name.text)) shadowedRoots.add(name.text);
    if (!fromRoute && ROUTE_PROP_NAMES.has(name.text)) disqualifiedRouteProps.add(name.text);
  };
  const visit = (node: ts.Node, fromRoute: boolean): void => {
    if (ts.isParameter(node)) {
      // The parameter itself and everything destructured out of it are the router's.
      bind(node.name, true);
      ts.forEachChild(node, (child) => visit(child, true));
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const awaited = node.initializer !== undefined && ts.isAwaitExpression(node.initializer);
      bind(node.name, awaited);
      ts.forEachChild(node, (child) => visit(child, awaited));
      return;
    }
    if (ts.isBindingElement(node)) bind(node.name, fromRoute);
    else if (ts.isFunctionDeclaration(node) && node.name !== undefined) bind(node.name, false);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) bind(node.name, false);
    else if (ts.isImportClause(node) && node.name !== undefined) bind(node.name, false);
    ts.forEachChild(node, (child) => visit(child, fromRoute));
  };
  ts.forEachChild(source, (child) => visit(child, false));
  return { shadowedRoots, disqualifiedRouteProps };
}

/** The names this file declares as `async` functions, whatever syntax declares them. */
function localAsyncNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      hasModifier(node, ts.SyntaxKind.AsyncKeyword)
    ) {
      names.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initialiser = node.initializer;
      if (initialiser !== undefined && isAsyncFunctionExpression(initialiser)) {
        names.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return names;
}

/** The methods that decide whether a value matches something written down. */
const MATCHERS = new Set(["test", "match", "includes"]);

/** Whether a `new` expression builds a `URL` out of the `url` property of a bare identifier. */
function buildsUrlFromRequest(node: ts.NewExpression): boolean {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "URL") return false;
  const [first] = node.arguments ?? [];
  return (
    first !== undefined &&
    ts.isPropertyAccessExpression(first) &&
    first.name.text === "url" &&
    ts.isIdentifier(first.expression)
  );
}

/** The two names a response is built under, whichever module a file imported it from. */
const RESPONSE_NAMES = new Set(["Response", "NextResponse"]);

/** The numeric `status` an options object literal carries, where it carries one. */
function statusIn(node: ts.Expression | undefined): number | undefined {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name;
    const named = (ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === "status";
    if (named && ts.isNumericLiteral(property.initializer)) {
      return Number(property.initializer.text);
    }
  }
  return undefined;
}

/**
 * The status a `new Response(body, { status })` or `new NextResponse(...)` carries.
 *
 * Scoped to the construction rather than read off any property named `status`, because that name
 * belongs to a domain object as often as to a response: a page holding `{ status: 404 }` for an
 * order was reported as answering a missing record by hand until this was narrowed.
 */
function responseStatusOf(node: ts.NewExpression): number | undefined {
  if (!ts.isIdentifier(node.expression) || !RESPONSE_NAMES.has(node.expression.text)) {
    return undefined;
  }
  return statusIn(node.arguments?.[1]);
}

/** The status a `Response.redirect(url, 308)` names, which is the other way one is written. */
function redirectStatusOf(node: ts.CallExpression): number | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "redirect") return undefined;
  if (!ts.isIdentifier(callee.expression) || !RESPONSE_NAMES.has(callee.expression.text)) {
    return undefined;
  }
  const [, status] = node.arguments;
  return status !== undefined && ts.isNumericLiteral(status) ? Number(status.text) : undefined;
}

/** Whether a `new` expression builds a `Response` whose body is a `JSON.stringify` call. */
function buildsJsonResponse(node: ts.NewExpression): boolean {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "Response") return false;
  const [first] = node.arguments ?? [];
  if (first === undefined || !ts.isCallExpression(first)) return false;
  const callee = first.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "JSON" &&
    callee.name.text === "stringify"
  );
}

/**
 * The tools whose configuration file a build or a test runner reads. A list rather than a pattern
 * over `*.config.*`: `sentry.server.config.ts` matches such a pattern and runs in the Next.js
 * runtime, so a pattern would set aside a file the framework itself loads.
 */
const CONFIGURED_TOOLS = new Set([
  "next",
  "eslint",
  "biome",
  "postcss",
  "tailwind",
  "playwright",
  "vitest",
  "jest",
  "commitlint",
  "knip",
  "lint-staged",
  "prettier",
  "svgo",
  "release",
  "stylelint",
]);

/** Whether a path names a build or test tool's own configuration. */
function isToolConfig(path: string): boolean {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const match = /^(.+)\.config\.[cm]?[jt]s$/.exec(name);
  return match !== null && CONFIGURED_TOOLS.has(match[1] ?? "");
}

/**
 * What a file's own contents and path say about where it runs. The Node-script reading is not
 * decided here: it needs the route tree, so it travels on the record as `looksLikeAScript`.
 */
function signalOf(
  path: string,
  root: string,
  imports: ReadonlyMap<string, readonly ImportBinding[]>,
  isServiceWorker: boolean,
): ElsewhereSignal | undefined {
  if (path.startsWith(join(root, "public") + sep)) return "public-asset";
  if (isServiceWorker) return "service-worker";
  // Read from the bindings, never the text: `next/router` inside a comment is not an import, and a
  // grep over one App Router page in formbricks sets the whole file aside.
  if ((imports.get("next/router") ?? []).length > 0) return "pages-router";
  if (isToolConfig(path)) return "tool-config";
  return undefined;
}

function parseFile(path: string, resolve: Resolver, root: string): SourceFileRecord | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  // JSX is only parsed when the script kind says so, and a .js file may well carry it.
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".ts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind);
  const imports = new Map<string, ImportBinding[]>();
  const moduleReferences: ModuleReference[] = [];
  const reference = (specifier: string, kind: ModuleReference["kind"], typeOnly: boolean): void => {
    moduleReferences.push({ specifier, kind, typeOnly, resolution: resolve(specifier, path) });
  };
  const exportedNames: string[] = [];
  const exportedTypeNames: string[] = [];
  /** Local names called inside a `try` that has a `catch`. A `try`/`finally` swallows nothing. */
  const calledUnderACatch = new Set<string>();
  let guardedDepth = 0;
  const functionDirectives: string[] = [];
  const cacheScopes: CacheScopeRecord[] = [];
  const exportedLiterals = new Map<string, string>();
  const exportedObjectKeys = new Map<string, readonly string[]>();
  const calledIdentifiers = new Set<string>();
  const importedLocals = importedLocalNames(source);
  // Read before the walk, because a call can name a constant the file declares below it.
  const constants = fileConstants(source);
  const calls: CallRecord[] = [];
  const fetchTags: CallArgument[] = [];
  const fetchCaches: CallArgument[] = [];
  const srcValues: string[] = [];
  const userAgents: string[] = [];
  const bodyReads: BodyRead[] = [];
  const globalAccess: GlobalAccess[] = [];
  // A service worker's `fetch` is the browser's, and takes none of the framework's options.
  let isServiceWorker = false;
  let readsProcessArgv = false;
  const unawaitedLocalAsyncCalls: string[] = [];
  const getArguments: string[] = [];
  const statusValues: number[] = [];
  const asyncLocals = localAsyncNames(source);
  const { shadowedRoots, disqualifiedRouteProps } = fileBindings(source);
  let catchClauses = 0;
  let matchesAValue = false;
  let parsesRequestUrl = false;
  let jsonResponses = 0;
  let readsSearchParams = false;
  let readsRouteParams = false;
  const environmentReads = new Set<string>();
  let hasDefaultExport = false;
  let hasAsyncDefaultExport = false;
  let extendedFetchCalls = 0;
  let plainFetchCalls = 0;

  const visit = (node: ts.Node, parent?: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const existing = imports.get(specifier) ?? [];
      existing.push(...bindingsOf(node));
      imports.set(specifier, existing);
      reference(specifier, "import", importIsTypeOnly(node));
    } else if (
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      isExported(node)
    ) {
      exportedTypeNames.push(node.name.text);
    } else if (ts.isExportAssignment(node)) {
      hasDefaultExport = true;
      if (isAsyncFunctionExpression(node.expression)) hasAsyncDefaultExport = true;
    } else if (ts.isFunctionDeclaration(node) && isExported(node)) {
      if (isDefaultExported(node) || !node.name) {
        hasDefaultExport = true;
        if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) hasAsyncDefaultExport = true;
      } else exportedNames.push(node.name.text);
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        exportedNames.push(declaration.name.text);
        if (declaration.initializer === undefined) continue;
        const value = literalArgument(declaration.initializer);
        if (value !== "unresolved") exportedLiterals.set(declaration.name.text, value.literal);
        const initializer = declaration.initializer;
        if (ts.isObjectLiteralExpression(initializer)) {
          exportedObjectKeys.set(declaration.name.text, objectKeysOf(initializer));
        } else if (
          ts.isAsExpression(initializer) &&
          ts.isObjectLiteralExpression(initializer.expression)
        ) {
          // `satisfies` and `as Metadata` are how the framework's own examples write it.
          exportedObjectKeys.set(declaration.name.text, objectKeysOf(initializer.expression));
        } else if (
          ts.isSatisfiesExpression(initializer) &&
          ts.isObjectLiteralExpression(initializer.expression)
        ) {
          exportedObjectKeys.set(declaration.name.text, objectKeysOf(initializer.expression));
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) exportedNames.push(element.name.text);
      }
      // `export * from` and `export { x } from` reach another module just as an import does.
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        reference(node.moduleSpecifier.text, "reexport", reexportIsTypeOnly(node));
      }
    } else if (ts.isPropertyAssignment(node) && propertyNameIs(node, "src")) {
      // Only a literal. A variable or an interpolated template names a source nobody wrote down,
      // and recording it would let a rule report a path that does not appear in the file.
      if (ts.isStringLiteral(node.initializer)) srcValues.push(node.initializer.text);
    } else if (ts.isPropertyAssignment(node) && propertyNameIs(node, "userAgent")) {
      userAgents.push(...userAgentLiteralsOf(node.initializer));
    } else if (ts.isPropertyAccessExpression(node)) {
      const key = environmentKeyOf(node);
      if (key !== undefined) environmentReads.add(key);
      const chain = chainOf(node, shadowedRoots);
      if (chain !== undefined)
        globalAccess.push({ path: chain, assigned: isAssignedTo(node, parent) });
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "process" &&
        node.name.text === "argv"
      ) {
        readsProcessArgv = true;
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "self" &&
        node.name.text === "addEventListener"
      ) {
        isServiceWorker = true;
      }
      // Gated on the binding rather than on the name: a local the file bound to something the
      // router never supplied answers a different question, whatever it is called.
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "searchParams" &&
        !disqualifiedRouteProps.has("searchParams")
      ) {
        readsSearchParams = true;
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "params" &&
        !disqualifiedRouteProps.has("params")
      ) {
        readsRouteParams = true;
      }
    } else if (ts.isTypeReferenceNode(node)) {
      if (ts.isIdentifier(node.typeName) && node.typeName.text === "ServiceWorkerGlobalScope") {
        isServiceWorker = true;
      }
    } else if (ts.isNewExpression(node)) {
      if (buildsUrlFromRequest(node)) parsesRequestUrl = true;
      if (buildsJsonResponse(node)) jsonResponses += 1;
      const status = responseStatusOf(node);
      if (status !== undefined) statusValues.push(status);
    } else if (ts.isRegularExpressionLiteral(node)) {
      matchesAValue = true;
    } else if (ts.isCatchClause(node)) {
      catchClauses += 1;
    } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      // A statement that is a bare call, never awaited. Only a name this file declares `async`,
      // because that declaration is what says the value dropped here is a promise.
      const callee = node.expression.expression;
      if (ts.isIdentifier(callee) && asyncLocals.has(callee.text)) {
        unawaitedLocalAsyncCalls.push(callee.text);
      }
    } else if (ts.isCallExpression(node)) {
      // Only a literal specifier is a reference; a computed one is not guessed at.
      if (isDynamicImport(node)) {
        const [specifier] = node.arguments;
        if (specifier && ts.isStringLiteral(specifier)) {
          reference(specifier.text, "dynamic", false);
        }
      }
      if (isExtendedFetch(node)) {
        extendedFetchCalls += 1;
        fetchTags.push(...fetchTagsOf(node, constants));
      }
      // Asked of every fetch, not only the extended ones: `cache` is the platform's own option.
      if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
        const cache = fetchCacheOf(node);
        if (cache !== undefined) fetchCaches.push(cache);
      }
      if (isPlainFetch(node)) plainFetchCalls += 1;
      const bodyRead = bodyReadOf(node);
      if (bodyRead !== undefined) bodyReads.push(bodyRead);
      const method = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : undefined;
      if (method === "get") {
        const [name] = node.arguments;
        if (name !== undefined && ts.isStringLiteral(name)) {
          getArguments.push(name.text.toLowerCase());
        }
      }
      if (method !== undefined && MATCHERS.has(method)) matchesAValue = true;
      const redirected = redirectStatusOf(node);
      if (redirected !== undefined) statusValues.push(redirected);
      // Only bare identifiers: the ledger anchors on import bindings, and a method call has none.
      if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        calledIdentifiers.add(name);
        if (guardedDepth > 0) calledUnderACatch.add(name);
        if (importedLocals.has(name)) {
          calls.push({
            callee: name,
            args: argumentsOf(node, constants),
            optionTags: optionTagsOf(node, constants),
          });
        }
      }
    }

    if (ts.isBlock(node)) {
      const blockDirectives = directivesOf(node.statements);
      functionDirectives.push(...blockDirectives);
      for (const directive of blockDirectives) {
        cacheScopes.push({ directive, calledIdentifiers: identifiersCalledIn(node) });
      }
    }

    // Only the `try` block itself, and only where a `catch` will see what it throws. The catch and
    // finally blocks are walked outside the guard: a call in the handler is not one the handler
    // caught.
    if (ts.isTryStatement(node) && node.catchClause !== undefined) {
      guardedDepth += 1;
      ts.forEachChild(node.tryBlock, (child) => visit(child, node.tryBlock));
      guardedDepth -= 1;
      visit(node.catchClause, node);
      if (node.finallyBlock !== undefined) visit(node.finallyBlock, node);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, node));
  };
  ts.forEachChild(source, (child) => visit(child, source));

  const fileDirectives = directivesOf(source.statements);
  const jsxElements = collectJsx(source);
  const lintSuppressions = readLintSuppressions(text);
  // A directive in the file prologue scopes the whole file, so the file is that scope's body.
  for (const directive of fileDirectives) {
    cacheScopes.push({ directive, calledIdentifiers });
  }

  const signal = signalOf(path, root, imports, isServiceWorker);

  return {
    path,
    fileDirectives,
    functionDirectives,
    imports,
    moduleReferences,
    exportedNames,
    exportedTypeNames,
    calledUnderACatch: [...calledUnderACatch].sort(),
    exportedLiterals,
    exportedObjectKeys,
    hasDefaultExport,
    hasAsyncDefaultExport,
    extendedFetchCalls,
    plainFetchCalls,
    calledIdentifiers,
    environmentReads,
    cacheScopes,
    calls,
    fetchTags,
    fetchCaches,
    srcValues,
    userAgents,
    bodyReads,
    globalAccess,
    catchClauses,
    unawaitedLocalAsyncCalls,
    getArguments,
    matchesAValue,
    parsesRequestUrl,
    jsonResponses,
    statusValues,
    readsSearchParams,
    readsRouteParams,
    comparesPathnameToLiteral: comparesPathnameToLiteral(source),
    socialImagePaths: socialImagePathsOf(source),
    jsxElements,
    lintSuppressions,
    ...(fileDirectives.includes(CLIENT_DIRECTIVE)
      ? {
          clientReasons: clientDirectiveReasons(
            source,
            jsxElements,
            moduleReferences.map((module) => module.specifier),
          ),
        }
      : {}),
    isTest: isTestFile(path),
    ...(signal === undefined ? {} : { runsElsewhere: signal }),
    looksLikeAScript: readsProcessArgv || text.startsWith("#!"),
  };
}

/** The property name, for the two spellings an object literal can use. */
function propertyNameIs(node: ts.PropertyAssignment, name: string): boolean {
  const key = node.name;
  if (ts.isIdentifier(key)) return key.text === name;
  return ts.isStringLiteral(key) && key.text === name;
}

/** Parses every source file once. Predicates read this index, never the filesystem. */
/**
 * Dependencies written as a workspace link that match no member the declaration names.
 *
 * A `workspace:*` range says the project expects a sibling to answer for it. Where none does, the
 * scan read less than the project holds, and saying so is the difference between "the API is not
 * used" and "the file that uses it was never opened".
 *
 * Only the explicit protocol counts. An ordinary version range that happens to name a member is a
 * dependency the project resolves from the registry as far as anything here can tell.
 */
function unmatchedWorkspaceLinks(projectRoot: string, linked: ReadonlySet<string>): string[] {
  const manifest = readPackageJson(join(projectRoot, "package.json"));
  if (manifest === undefined || manifest === null) return [];
  const linkedNames = new Set(
    [...linked].map((directory) => packageNameAt(directory)).filter((name) => name !== undefined),
  );
  const unmatched: string[] = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    const declared = (manifest as Record<string, unknown>)[field];
    if (typeof declared !== "object" || declared === null) continue;
    for (const [name, range] of Object.entries(declared as Record<string, unknown>)) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
      if (!linkedNames.has(name)) unmatched.push(name);
    }
  }
  return unmatched.sort();
}

export function scanSources(root: string): SourceIndex {
  const files: SourceFileRecord[] = [];
  const byPath = new Map<string, SourceFileRecord>();
  // The linked members are computed once and shared: the resolver needs them to answer `internal`
  // for a symlinked specifier, and the walk needs them as extra roots.
  const linked = linkedPackages(root);
  // A specifier written inside a linked package answers to that package's own manifest, not to the
  // app's: `packages/ui` declares `@base-ui/react` and `apps/www` never does, so checking the app's
  // manifest for a name the linked package depends on reported a dependency the project has as one
  // it lacks.
  const linkedDeclarations = new Map(
    [...linked].map((directory) => [directory, declaredPackagesAt(directory)] as const),
  );
  const resolve = createResolver(root, undefined, declaredPackagesAt(root), linkedDeclarations);
  let internal = 0;
  let external = 0;
  let unresolved = 0;
  let assets = 0;
  const missing = new Map<string, MissingPackage>();

  for (const path of findSourceFiles(root)) {
    const record = parseFile(path, resolve, root);
    if (!record) continue;
    files.push(record);
    byPath.set(path, record);
    for (const { resolution } of record.moduleReferences) {
      if (resolution.kind === "internal") internal += 1;
      else if (resolution.kind === "external") external += 1;
      else if (resolution.kind === "asset") assets += 1;
      else if (resolution.kind === "missing-package") {
        const seen = missing.get(resolution.name);
        missing.set(resolution.name, {
          name: resolution.name,
          declared: resolution.declared,
          references: (seen?.references ?? 0) + 1,
        });
      } else unresolved += 1;
    }
  }
  // Sorted by name so nothing downstream depends on which file was parsed first.
  const missingPackages = [...missing.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    files,
    byPath,
    resolution: { internal, external, unresolved, assets, missingPackages },
    linked: { scanned: linked.size, unmatched: unmatchedWorkspaceLinks(root, linked).length },
  };
}

/** Files importing `imported` from `module`, ignoring type-only imports. */
export function filesImporting(
  index: SourceIndex,
  module: string,
  imported: string,
): SourceFileRecord[] {
  return index.files.filter((file) =>
    (file.imports.get(module) ?? []).some(
      (binding) => binding.imported === imported && !binding.typeOnly,
    ),
  );
}

/** Files importing the module at all, whatever the bindings. Used for module-level pages. */
export function filesImportingModule(index: SourceIndex, module: string): SourceFileRecord[] {
  return index.files.filter((file) => file.imports.has(module));
}

/** Files that describe what the project renders in production. */
/**
 * Whether a reading places this file outside the Next.js server runtime.
 *
 * The script reading is settled here rather than on the record: a `next.config.ts` reads
 * `process.argv` too, and only the route tree tells the two apart. A file the tree reaches is one
 * the framework runs, whatever the file itself shows.
 */
export function placedElsewhere(
  file: SourceFileRecord,
  reachedByAConvention: (path: string) => boolean,
): ElsewhereSignal | undefined {
  if (file.runsElsewhere !== undefined) return file.runsElsewhere;
  if (file.looksLikeAScript && !reachedByAConvention(file.path)) return "node-script";
  return undefined;
}

export function productionFiles(index: SourceIndex): SourceFileRecord[] {
  return index.files.filter((file) => !file.isTest);
}

export function hasDirective(file: SourceFileRecord, directive: string): boolean {
  return file.fileDirectives.includes(directive) || file.functionDirectives.includes(directive);
}

/** Every file that calls `local` where `local` binds `imported` from `module`. */
export function callsResolvedTo(
  index: SourceIndex,
  module: string | readonly string[],
  imported: string,
): { file: SourceFileRecord; call: CallRecord }[] {
  // Several modules where one export is the same export: `next/cache` re-exports `cacheTag` from
  // `next/dist/server/use-cache/cache-tag`, and a project writing the inner path calls the very
  // same function. Asking for a name under a module that does not export it simply finds nothing,
  // so listing the paths a symbol travels costs no precision.
  const modules = typeof module === "string" ? [module] : module;
  const found: { file: SourceFileRecord; call: CallRecord }[] = [];
  for (const file of index.files) {
    const locals = new Set(
      modules
        .flatMap((name) => file.imports.get(name) ?? [])
        .filter((binding) => binding.imported === imported && !binding.typeOnly)
        .map((binding) => binding.local),
    );
    if (locals.size === 0) continue;
    for (const call of file.calls) {
      if (locals.has(call.callee)) found.push({ file, call });
    }
  }
  return found;
}
