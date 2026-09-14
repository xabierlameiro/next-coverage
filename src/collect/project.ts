import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Resolved, resolved, type StopReason, unresolved } from "../types.js";
import {
  type NextConfigSource,
  type PackageDirectoryResolver,
  readNextConfig,
  readPageExtensions,
} from "./config.js";
import { unversionedDirectories } from "./ignored.js";

type PackageJson = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly version?: string;
  readonly scripts?: Record<string, string>;
};

/** The bundlers a project's scripts run, which is what decides whether an option applies at all. */
export type Bundler = "turbopack" | "webpack";

/** Where the installed CLI declares the flags it accepts. Compiled output, so the read is defensive. */
const CLI_BIN = join("dist", "bin", "next");

/**
 * The declaration the CLI's own argument parser writes for every flag, and the shape this anchors
 * on. Both spellings appear in the compiled bin — `.option('--webpack', '…')` for the ordinary
 * ones and `new Option('--foo', '…')` where the flag carries extra configuration.
 */
const FLAG_DECLARATION = /(?:\.option|new (?:_commander\.)?Option)\(\s*['"](--[a-z0-9-]+)/gi;

/**
 * A token in a script that is *about* the bundler, whatever the CLI thinks of it. Matching the
 * shape rather than the declared list is the point: a spelling the CLI does not declare has to be
 * recognisable as an attempt to pick a bundler before it can be reported as one that will not work.
 */
const BUNDLER_SHAPED = /^--(?:no-)?(?:turbo|turbopack|webpack)$/;

/** The declared spellings this maps onto a bundler. A declared flag outside this map picks neither. */
const PICKS: ReadonlyMap<string, Bundler> = new Map([
  ["--turbo", "turbopack"],
  ["--turbopack", "turbopack"],
  ["--webpack", "webpack"],
]);

/**
 * Every flag the installed CLI declares, read from its own compiled bin.
 *
 * Nothing else in this repository can say which spellings a release accepts, and the answer moves:
 * `--turbo` is the old name for `--turbopack` and both are still declared, while `--no-turbopack`
 * is a spelling two of the referenced projects write and no release measured has ever declared.
 * Unresolved where the package is absent or the bin does not parse as expected — a reading of the
 * flags that guesses is worse than one that says it could not look.
 */
function declaredFlagsOf(installed: InstalledNext | undefined): Resolved<ReadonlySet<string>> {
  if (!installed) return unresolved("no installed next package to read the CLI's flags from");
  let source: string;
  try {
    source = readFileSync(join(installed.realPath, CLI_BIN), "utf8");
  } catch {
    return unresolved("the installed CLI's bin could not be read");
  }
  const flags = new Set<string>();
  for (const [, flag] of source.matchAll(FLAG_DECLARATION)) {
    if (flag !== undefined) flags.add(flag);
  }
  // Every release measured declares dozens. A handful means the anchor found something else.
  return flags.size < 10
    ? unresolved("the installed CLI's bin declared too few flags to be the list")
    : resolved(flags);
}

/**
 * The bundlers the project's own scripts declare, one reading per script that invokes the CLI.
 *
 * Turbopack is the default the installed CLI documents — `--turbopack` is "Force enable Turbopack
 * (enabled by default)" and `--webpack` is "Use Webpack instead of the default Turbopack bundler"
 * — so a project runs webpack only where it says so.
 *
 * A script picking a bundler with a spelling the installed CLI does not declare is read as nothing
 * rather than as the default. `next build --no-turbopack` is the case: the flag is not declared, so
 * the command does not run, and a script that does not run says nothing about how the project
 * builds. Reading it as the default would put two of the six referenced projects on the wrong side
 * of every gate resting on this.
 *
 * Unresolved where nothing invokes the CLI, where no invoking script reads, or where the CLI's own
 * flags could not be read. A manifest that declares no such script has not said it uses the default;
 * it has said nothing, and somebody running `next build` by hand or through a task runner is a
 * project this reading knows nothing about.
 */
function bundlersOf(
  pkg: PackageJson | undefined,
  installed: InstalledNext | undefined,
): Resolved<ReadonlySet<Bundler>> {
  if (!pkg) return unresolved("the project manifest could not be read");
  const invoking = Object.values(pkg.scripts ?? {}).filter((command) =>
    /(^|[\s;&|])next(\s|$)/.test(command),
  );
  if (invoking.length === 0) {
    return unresolved("no script in the manifest invokes the framework's CLI");
  }
  const declared = declaredFlagsOf(installed);
  if (declared.status !== "resolved") return declared;

  const bundlers = new Set<Bundler>();
  const undeclared = new Set<string>();
  for (const command of invoking) {
    // Read as tokens, the way a shell would: `--webpackery` is another flag entirely.
    const picking = command.split(/\s+/).filter((token) => BUNDLER_SHAPED.test(token));
    const unknown = picking.filter((token) => !declared.value.has(token));
    if (unknown.length > 0) {
      for (const token of unknown) undeclared.add(token);
      continue;
    }
    const picked = picking.map((token) => PICKS.get(token)).filter((it) => it !== undefined);
    // No flag at all is the default, which is what the CLI declaring `--webpack` as the opt-out says.
    if (picked.length === 0) bundlers.add("turbopack");
    else for (const bundler of picked) bundlers.add(bundler);
  }
  return bundlers.size === 0
    ? unresolved(
        `every script invoking the CLI picks a bundler the installed release does not declare: ${[...undeclared].sort().join(", ")}`,
      )
    : resolved(bundlers);
}

/** Every package name a project's manifest declares, for anything that needs it before discovery. */
/**
 * The nearest ancestor that declares a workspace, starting at the project itself.
 *
 * Walks up the way `resolveProjectRoot` does, over a different file: a monorepo declares its members
 * at the repository root and an app sits several directories below it, so a reader starting at the
 * app sees no workspace at all. That is what made a linked package look like a dependency nobody
 * could open — the members were declared two levels above where anything looked.
 *
 * The project's own directory counts, so a single-package repository that declares a workspace in
 * its own manifest is found without a special case.
 */
export function resolveWorkspaceRoot(startDir: string): string | undefined {
  // Absolute for the same reason `resolveProjectRoot` is: this walk climbs the same way.
  let current = resolvePath(startDir);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const pkg = readPackageJson(join(current, "package.json"));
    if (pkg !== undefined && pkg !== null && "workspaces" in pkg) return current;
    const parent = dirname(current);
    if (parent === current || parent === parsePath(current).root) return undefined;
    current = parent;
  }
}

/** The package globs a project declares, from either record, with the shapes this cannot read left out. */
/** A package glob naming one directory, or the children of one: `dir`, `dir/sub` or `dir/*`. */
const PLAIN_PACKAGE_GLOB = /^[^*?!]+(?:\/\*)?$/;

/** Directory names under a path, or none where it cannot be read. */
function safeEntries(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function packageGlobs(root: string): string[] {
  const globs: string[] = [];
  try {
    const workspace: unknown = parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
    const declared = (workspace as { packages?: unknown } | null)?.packages;
    if (Array.isArray(declared)) globs.push(...declared.filter((g) => typeof g === "string"));
  } catch {
    // No workspace record, or one this cannot parse. Either way it declares no package here.
  }
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const declared = (manifest as { workspaces?: unknown }).workspaces;
    const list = Array.isArray(declared)
      ? declared
      : (declared as { packages?: unknown } | undefined)?.packages;
    if (Array.isArray(list)) globs.push(...list.filter((g) => typeof g === "string"));
  } catch {
    // The manifest is read for its dependencies elsewhere; its absence is reported there.
  }
  // A repository may declare its members twice — pnpm reads the YAML, npm and yarn read the
  // manifest, and a project that supports either keeps both in step. The two lists are the same
  // workspace said twice, not two workspaces, so a glob repeated across them is counted once.
  return [...new Set(globs.filter((glob) => PLAIN_PACKAGE_GLOB.test(glob)))];
}

/** The name a package calls itself, read off its own manifest. */
export function packageNameAt(directory: string): string | undefined {
  const manifest = readPackageJson(join(directory, "package.json"));
  const name = (manifest as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name !== "" ? name : undefined;
}

export function declaredPackagesAt(root: string): ReadonlySet<string> | undefined {
  const declared = declaredPackagesOf(readPackageJson(join(root, "package.json")));
  return declared.status === "resolved" ? declared.value : undefined;
}

export function readPackageJson(path: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

function declaredPackagesOf(pkg: PackageJson | undefined): Resolved<ReadonlySet<string>> {
  if (!pkg) return unresolved("the project manifest could not be read");
  const names = new Set<string>();
  for (const kind of [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ]) {
    for (const name of Object.keys(kind ?? {})) names.add(name);
  }
  return resolved(names);
}

function declaredNextRange(pkg: PackageJson): string | undefined {
  return pkg.dependencies?.next ?? pkg.devDependencies?.next;
}

/**
 * The version a pnpm catalog holds under a name, or nothing where it holds none.
 *
 * A member declaring `next: 'catalog:'` has named a version — it is written once in
 * `pnpm-workspace.yaml` and every member points at it — and printing the pointer back at the
 * reader as `(next catalog:)` reports the indirection instead of the answer. The default catalog
 * is `catalog`; a named one, spelled `catalog:react18`, sits under `catalogs`.
 */
function catalogVersion(workspaceRoot: string, spec: string, name: string): string | undefined {
  if (!spec.startsWith("catalog:")) return undefined;
  let record: unknown;
  try {
    record = parseYaml(readFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8"));
  } catch {
    return undefined;
  }
  const catalogue = spec.slice("catalog:".length).trim();
  const source =
    catalogue === "" || catalogue === "default"
      ? (record as { catalog?: unknown } | null)?.catalog
      : ((record as { catalogs?: Record<string, unknown> } | null)?.catalogs?.[catalogue] ?? {});
  const version = (source as Record<string, unknown> | null | undefined)?.[name];
  return typeof version === "string" && version !== "" ? version : undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Walks up from `startDir` to the nearest package.json that declares `next`. */
export function resolveProjectRoot(startDir: string): string | undefined {
  // Resolved before the walk, because the walk climbs with `dirname` and a relative path has
  // nowhere to climb to: `dirname(".")` is `"."`, so the loop stopped on its first step and
  // `next-coverage .` run from inside `app/` answered that no project sits above it.
  let current = resolvePath(startDir);
  for (;;) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      const pkg = readPackageJson(manifest);
      if (pkg && declaredNextRange(pkg) !== undefined) return current;
    }
    const parent = dirname(current);
    if (parent === current || parent === parsePath(current).root) return undefined;
    current = parent;
  }
}

export type InstalledNext = {
  /** The real directory of the package, with package-manager symlinks resolved. */
  readonly realPath: string;
  /** The path we looked it up through, which may be a symlink into a pnpm store. */
  readonly linkPath: string;
  readonly version: string;
};

/**
 * Locates an installed package by name and resolves its real path.
 * pnpm makes this mandatory: `node_modules/<name>` is a symlink into `.pnpm/`, and
 * without following it the package's own files are unreachable. Walks up so a package
 * hoisted to a workspace root is still found.
 *
 * Nothing here is specific to `next`, which is why it takes the name: reading a default
 * list out of any installed package is the same act as reading the bundled docs.
 */
export function resolveInstalledPackage(
  projectRoot: string,
  name: string,
): InstalledNext | undefined {
  let current = projectRoot;
  for (;;) {
    const linkPath = join(current, "node_modules", ...name.split("/"));
    if (isDirectory(linkPath)) {
      let realPath: string;
      try {
        realPath = realpathSync(linkPath);
      } catch {
        realPath = linkPath;
      }
      const pkg = readPackageJson(join(realPath, "package.json"));
      if (pkg?.version) return { realPath, linkPath, version: pkg.version };
    }
    const parent = dirname(current);
    if (parent === current || parent === parsePath(current).root) return undefined;
    current = parent;
  }
}

/** The installed `next`, which every derivation in this tool rests on. */
export function resolveInstalledNext(projectRoot: string): InstalledNext | undefined {
  return resolveInstalledPackage(projectRoot, "next");
}

/**
 * The major version of the TypeScript the project has installed.
 *
 * The installed copy rather than the declared range: `^6.0.2` may resolve to 6.9 and `*` to
 * anything, and a finding about what a build would use needs what is there. The surface is derived
 * from the installed `next` for the same reason.
 */
function installedTypeScriptMajor(projectRoot: string): Resolved<number> {
  const installed = resolveInstalledPackage(projectRoot, "typescript");
  if (installed === undefined) return unresolved("no installed typescript to read");
  const major = Number.parseInt(installed.version, 10);
  return Number.isNaN(major)
    ? unresolved(`could not read a version from '${installed.version}'`)
    : resolved(major);
}

export type AppDirectory = {
  readonly path: string;
  /** Set when `src/app` exists but `app/` wins, matching Next.js resolution order. */
  readonly shadowed?: string;
};

export function resolveAppDirectory(projectRoot: string): AppDirectory | undefined {
  const rootApp = join(projectRoot, "app");
  const srcApp = join(projectRoot, "src", "app");
  const hasRootApp = isDirectory(rootApp);
  const hasSrcApp = isDirectory(srcApp);

  if (hasRootApp) return hasSrcApp ? { path: rootApp, shadowed: srcApp } : { path: rootApp };
  if (hasSrcApp) return { path: srcApp };
  return undefined;
}

export function hasPagesRouter(projectRoot: string): boolean {
  return isDirectory(join(projectRoot, "pages")) || isDirectory(join(projectRoot, "src", "pages"));
}

export type ProjectContext = {
  readonly root: string;
  readonly appDirectory: AppDirectory;
  readonly installedNext: InstalledNext | undefined;
  /** Exact installed version, or unresolved when only a range is declared. */
  readonly version: Resolved<string>;
  readonly config: NextConfigSource | undefined;
  /**
   * Package names the manifest declares, across every dependency kind. Unresolved when the
   * manifest could not be read: an unreadable manifest declares nothing and knows nothing, and
   * treating it as empty would make every package look undeclared.
   */
  readonly declaredPackages: Resolved<ReadonlySet<string>>;
  /**
   * The bundlers the manifest's scripts run. Kept as a set rather than one answer: a project may
   * develop with one and build with another, and a single value would be wrong for one of them.
   */
  readonly bundlers: Resolved<ReadonlySet<Bundler>>;
  /** The major version of the installed TypeScript, which one documented failure turns on. */
  readonly typeScriptMajor: Resolved<number>;
  readonly pageExtensions: Resolved<readonly string[]>;
};

export type Discovery =
  | { readonly kind: "ok"; readonly project: ProjectContext }
  | { readonly kind: "stopped"; readonly reason: StopReason };

/**
 * The workspace members that are Next apps in their own right: each declares `next` and resolves an
 * app directory of its own.
 *
 * Read only when discovery is about to stop. Pointing the tool at a monorepo root is a common
 * mistake and the answer "no Next.js project found" is true of that directory and useless to the
 * reader, who is standing in a repository full of them.
 */
/** A directory offered to the reader as an app: where it is, and the version it declares. */
type FoundApp = { readonly directory: string; readonly declares?: string };

/**
 * The directory as an app, or nothing where it is not one.
 *
 * One test, asked from both places that offer a reader somewhere else to point the tool: the
 * members a workspace declares, and the directories found below a root that declares nothing. Two
 * spellings of the same question would let one of them drift into answering a slightly different
 * one, and the difference would show up as a directory named by one path and withheld by the other.
 *
 * `catalogRoot` is where a `catalog:` range is resolved from, which is the workspace for a declared
 * member and the starting directory otherwise.
 */
function appAt(directory: string, catalogRoot: string): FoundApp | undefined {
  const manifest = readPackageJson(join(directory, "package.json"));
  const range =
    manifest === undefined || manifest === null ? undefined : declaredNextRange(manifest);
  if (range === undefined) return undefined;
  if (resolveAppDirectory(directory) === undefined) return undefined;
  const declares = catalogVersion(catalogRoot, range, "next") ?? range;
  return { directory, ...(declares === "" ? {} : { declares }) };
}

/**
 * Where a package specifier the config imports from lives, for the workspace members this project
 * declares a dependency on.
 *
 * A member the project does not depend on is somebody else's package sitting in the same tree, and
 * a specifier resolving to it would read a file this project never loads. A specifier naming a
 * package outside the workspace resolves to nothing: an installed dependency's own source is not
 * this project's statement about its configuration.
 */
function workspacePackageResolver(projectRoot: string): PackageDirectoryResolver {
  // Scanning the workspace means reading every member's manifest, and a configuration importing
  // from two packages would otherwise pay for it twice. The cache lives with the resolver, so it
  // spans one project's read and never leaks into another's.
  const answered = new Map<string, string | undefined>();
  return (specifier) => {
    const cached = answered.get(specifier);
    if (cached !== undefined || answered.has(specifier)) return cached;
    const found = resolveWorkspacePackage(projectRoot, specifier);
    answered.set(specifier, found);
    return found;
  };
}

function resolveWorkspacePackage(projectRoot: string, specifier: string): string | undefined {
  {
    const workspaceRoot = resolveWorkspaceRoot(projectRoot);
    if (workspaceRoot === undefined) return undefined;
    const dependencies = declaredPackagesAt(projectRoot);
    if (dependencies === undefined || !dependencies.has(specifier)) return undefined;

    for (const glob of packageGlobs(workspaceRoot)) {
      const directories = glob.endsWith("/*")
        ? safeEntries(resolvePath(workspaceRoot, glob.slice(0, -2))).map((name) =>
            join(resolvePath(workspaceRoot, glob.slice(0, -2)), name),
          )
        : [resolvePath(workspaceRoot, glob)];
      const match = directories.find((directory) => packageNameAt(directory) === specifier);
      if (match !== undefined) return match;
    }
    return undefined;
  }
}

function memberApps(workspaceRoot: string): readonly FoundApp[] {
  const found: FoundApp[] = [];
  // Globs overlap — `apps/*` and a member named outright reach the same directory — and the reader
  // is being offered apps to analyse, not the ways each one was declared.
  const seen = new Set<string>();
  for (const glob of packageGlobs(workspaceRoot)) {
    const directories = glob.endsWith("/*")
      ? safeEntries(resolvePath(workspaceRoot, glob.slice(0, -2))).map((name) =>
          join(resolvePath(workspaceRoot, glob.slice(0, -2)), name),
        )
      : [resolvePath(workspaceRoot, glob)];
    for (const directory of directories) {
      if (seen.has(directory)) continue;
      seen.add(directory);
      const app = appAt(directory, workspaceRoot);
      if (app !== undefined) found.push(app);
    }
  }
  return found.sort((a, b) => (a.directory < b.directory ? -1 : 1));
}

/** How far below the starting directory the search for an undeclared app reaches. */
const UNDECLARED_SEARCH_DEPTH = 2;

/** Never entered by the search: an installed framework is not the project that installed it. */
const NEVER_SEARCHED = "node_modules";

/**
 * The apps sitting below a directory that declares none of them.
 *
 * A repository is not obliged to declare a workspace, and three of the largest public Next.js
 * repositories do not: the app is `web/`, or `frontend/`, or `platform/frontend/`, and the root
 * above it holds either a manifest that declares nothing or no manifest at all. Every reader of a
 * declaration walks straight past them, and what the tool said instead was that it found no
 * Next.js project — of a directory holding one, one turn away.
 *
 * Breadth-first, so a level-one app is answered without paying for level two at all, and bounded at
 * two levels because that is what the measured shapes need. An unbounded walk would make the
 * stopping point a function of how large the repository is, which is not something a reader can
 * reason about.
 *
 * Read only where discovery has already failed every other way, so no directory that resolves
 * today reaches it.
 */
function appsBelow(from: string): readonly FoundApp[] {
  const start = resolvePath(from);
  const ignored = unversionedDirectories(start);
  const found: FoundApp[] = [];
  let level = [start];
  for (let depth = 0; depth < UNDECLARED_SEARCH_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      for (const name of safeEntries(directory)) {
        // A dot-prefixed name is the repository's own machinery — `.git`, `.next`, `.turbo` — and
        // `node_modules` holds thousands of manifests declaring the framework, none of them a
        // project. Both are skipped whatever the repository ignores, because a repository that
        // commits no `.gitignore` still holds neither.
        if (name === NEVER_SEARCHED || name.startsWith(".") || ignored.has(name)) continue;
        next.push(join(directory, name));
      }
    }
    for (const directory of next) {
      const app = appAt(directory, start);
      if (app !== undefined) found.push(app);
    }
    // A level that answered is not deepened: the reader is being offered somewhere to point the
    // tool, and the app nearest the directory they named is the one they meant.
    if (found.length > 0) break;
    level = next;
  }
  return found.sort((a, b) => (a.directory < b.directory ? -1 : 1));
}

/**
 * The member apps of the workspace `from` sits in, or none where it sits in no workspace.
 *
 * Read before answering that a directory holds nothing to analyse. Pointing the tool at a monorepo
 * root is a common mistake, and naming the apps is the difference between an answer the reader can
 * act on and one that is merely true.
 */
function workspaceHolding(
  from: string,
): Extract<StopReason, { kind: "workspace-root" }> | undefined {
  const root = resolveWorkspaceRoot(from);
  if (root === undefined) return undefined;
  const apps = memberApps(root);
  return apps.length > 0 ? { kind: "workspace-root", root, apps } : undefined;
}

export function discoverProject(startDir: string): Discovery {
  const root = resolveProjectRoot(startDir);
  if (!root) {
    const workspace = workspaceHolding(startDir);
    if (workspace !== undefined) return { kind: "stopped", reason: workspace };
    // Last, after every reader of a declaration has declined, so nothing that resolves today can
    // reach it. A declared workspace answers first even where an undeclared directory would also
    // qualify: the repository said where its apps are, and that is the better authority.
    const below = appsBelow(startDir);
    if (below.length > 0) {
      return {
        kind: "stopped",
        reason: { kind: "apps-below", from: resolvePath(startDir), apps: below },
      };
    }
    // The resolved path, because "at or above ." names a directory the reader has to work out.
    return { kind: "stopped", reason: { kind: "no-project", from: resolvePath(startDir) } };
  }

  const appDirectory = resolveAppDirectory(root);
  if (!appDirectory) {
    // A monorepo root commonly declares `next` itself, to hold the CLI the workspace scripts run,
    // which makes it look like a project until the app directory it has no reason to hold turns up
    // missing. Asymmetric-al/core is that shape: three member apps, and "has no app directory" said
    // of the one directory in the repository that was never going to have one. The router reading
    // still wins where the root really is a project, because a Pages Router app names its own
    // problem better than a list of its neighbours would.
    const pagesRouter = hasPagesRouter(root);
    if (!pagesRouter) {
      const workspace = workspaceHolding(root);
      if (workspace !== undefined) return { kind: "stopped", reason: workspace };
    }
    return {
      kind: "stopped",
      reason: { kind: "no-app-router", root, hasPagesRouter: pagesRouter },
    };
  }

  const installedNext = resolveInstalledNext(root);
  const declared = readPackageJson(join(root, "package.json"));
  const version: Resolved<string> = installedNext
    ? resolved(installedNext.version)
    : unresolved(
        `no installed next package found; manifest declares '${
          (declared && declaredNextRange(declared)) ?? "nothing"
        }'`,
      );

  const config = readNextConfig(root, workspacePackageResolver(root));
  return {
    kind: "ok",
    project: {
      root,
      appDirectory,
      installedNext,
      version,
      config,
      declaredPackages: declaredPackagesOf(declared),
      bundlers: bundlersOf(declared, installedNext),
      typeScriptMajor: installedTypeScriptMajor(root),
      pageExtensions: readPageExtensions(config),
    },
  };
}
