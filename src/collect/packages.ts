import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import ts from "typescript";
import { type Resolved, resolved, unresolved } from "../types.js";

/**
 * Reading a dependency the project declares, rather than the framework the analysis already
 * resolves. Two conditions need it and nothing else does, so the reading is bounded here rather
 * than offered as a general way into `node_modules`.
 *
 * Two files per candidate, both named by the dependency itself: its own `package.json`, and the
 * entry module that manifest points at. No directory is listed and nothing above the project root
 * is opened — a resolver that climbed would answer about a package the analysed project does not
 * have, which is the version mistake every reader in `defaults.ts` is written to avoid.
 *
 * Every failure is `unresolved` carrying its reason. A dependency that will not open is a question
 * this tool declines rather than one it guesses at.
 */

/** The manifest fields a condition in this family reads, and no others. */
export type DependencyManifest = {
  /** Whether the package declares a node-gyp build, which is a native addon by construction. */
  readonly gypfile: boolean;
  /** Absolute path of the entry module the manifest names, through `exports` or `main`. */
  readonly entry: string;
};

/** A specifier naming a package: a bare name, or a scope and a name. Nothing else resolves. */
const BARE_SPECIFIER = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The installed directory of a package the project declares, looked for in the project's own
 * `node_modules` and nowhere else.
 *
 * The framework resolver climbs to the filesystem root, which is right for `next` — a tool asking
 * what the project runs wants whichever copy the runtime would load. It is wrong here: this asks
 * whether the analysed project bundles a dependency, and a package found three directories above
 * it belongs to somebody else's tree.
 */
export function resolveDependency(root: string, specifier: string): Resolved<string> {
  if (!BARE_SPECIFIER.test(specifier)) {
    return unresolved(`'${specifier}' is not a bare package specifier`);
  }

  const directory = join(root, "node_modules", ...specifier.split("/"));
  // The specifier is already known to hold no separator other than a scope's, so this cannot
  // escape — asserted rather than assumed, because the cost of being wrong is reading a file the
  // project never named.
  const inside = relative(root, directory);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    return unresolved(`'${specifier}' resolves outside ${root}`);
  }
  if (!isDirectory(directory)) {
    return unresolved(`'${specifier}' is not installed under ${root}`);
  }
  return resolved(directory);
}

/**
 * The entry path a manifest names, through whichever of the two fields carries it.
 *
 * `exports` wins where it is present, because a package declaring one has said that is what an
 * importer reaches. Only its root condition is read, and only where that resolves to a string:
 * a conditional map naming a different file per runtime states more than one entry, and picking
 * one of them would report on a module the project may never load.
 */
function entryPathOf(manifest: Record<string, unknown>): string | undefined {
  const exports = manifest.exports;
  if (typeof exports === "string") return exports;
  if (exports !== null && typeof exports === "object") {
    const root = (exports as Record<string, unknown>)["."];
    if (typeof root === "string") return root;
    if (root !== null && typeof root === "object") {
      const conditions = root as Record<string, unknown>;
      for (const condition of ["import", "default", "require"]) {
        const value = conditions[condition];
        if (typeof value === "string") return value;
      }
    }
    return undefined;
  }
  return typeof manifest.main === "string" ? manifest.main : undefined;
}

/**
 * The two facts a condition reads off an installed dependency's own manifest.
 *
 * `gypfile` is the declaration npm writes when a package builds a native addon, so it is the
 * package saying so about itself rather than this tool classifying its contents. An entry the
 * manifest does not name leaves nothing to parse, and the read is unresolved rather than falling
 * back to a conventional file name the package never wrote.
 */
export function readDependencyManifest(directory: string): Resolved<DependencyManifest> {
  const path = join(directory, "package.json");
  const parsed = readJson(path);
  if (parsed === null || typeof parsed !== "object") {
    return unresolved(`${path} is not a readable manifest`);
  }
  const manifest = parsed as Record<string, unknown>;

  const entry = entryPathOf(manifest);
  if (entry === undefined) {
    return unresolved(`${path} names no entry module through 'exports' or 'main'`);
  }

  const resolvedEntry = resolvePath(directory, entry);
  if (relative(directory, resolvedEntry).startsWith("..")) {
    return unresolved(`${path} names an entry outside its own package`);
  }

  return resolved({ gypfile: manifest.gypfile === true, entry: resolvedEntry });
}

/**
 * Whether a module is nothing but re-exports: every top-level statement an `export … from`.
 *
 * This is the shape the `optimizePackageImports` page describes without measuring it — a package
 * whose entry reaches hundreds or thousands of modules is one that re-exports them. How many it
 * reaches is not claimed here, because counting them means opening every module it names, and the
 * reading is bounded to this one file.
 *
 * A module with no statements is not a barrel. An empty file re-exports nothing, and reporting one
 * would name a package for holding nothing at all.
 */
export function isReexportOnly(entry: string): Resolved<boolean> {
  let text: string;
  try {
    text = readFileSync(entry, "utf8");
  } catch {
    return unresolved(`${entry} could not be read`);
  }

  const source = ts.createSourceFile(entry, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const statements = source.statements.filter(
    (statement) => !ts.isEmptyStatement(statement) && !ts.isNotEmittedStatement(statement),
  );
  if (statements.length === 0) return resolved(false);

  return resolved(
    statements.every(
      (statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined,
    ),
  );
}
