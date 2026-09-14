import { existsSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, sep } from "node:path";
import ts from "typescript";

/**
 * What an import specifier turned out to be. `external` covers everything that resolves to no code
 * of this project's own: a dependency, and also a declaration file, which carries types and nothing
 * that survives to runtime.
 */
export type ModuleResolution =
  | { readonly kind: "internal"; readonly path: string }
  | { readonly kind: "external" }
  /** A stylesheet or other non-code reference. Carries no directive, no import and no code. */
  | { readonly kind: "asset" }
  /**
   * A package the code imports and the project does not have. Had it been installed it would be
   * external, and the closure stops at external, so its absence changes nothing the walk can see.
   * Whether the manifest declares it separates an installation the reader can run from code that
   * runs somewhere else entirely.
   */
  | { readonly kind: "missing-package"; readonly name: string; readonly declared: Declared }
  /** A specifier that should have named this project's own code and did not. */
  | { readonly kind: "unresolved" };

/** Whether the manifest declares an absent package. Unknown when it could not be read. */
export type Declared = "yes" | "no" | "unknown";

export type Resolver = (specifier: string, fromFile: string) => ModuleResolution;

const EXTERNAL: ModuleResolution = { kind: "external" };
const ASSET: ModuleResolution = { kind: "asset" };
const UNRESOLVED: ModuleResolution = { kind: "unresolved" };

/**
 * Recognised from the specifier, never by reading the file: a specifier ending in one of these
 * names a stylesheet whatever sits at the other end, and the scan indexes none of them.
 *
 * Images, fonts and JSON are deliberately absent. No fixture imports one that fails to resolve, so
 * adding them would be writing a list on a guess about what a project might do.
 */
const STYLESHEET_EXTENSIONS = [".css", ".scss", ".sass", ".less"] as const;

function isStylesheet(specifier: string): boolean {
  // A query suffix is a bundler convention (`./a.css?inline`), so the extension is looked for
  // before one rather than at the very end.
  const withoutQuery = specifier.split("?")[0] ?? specifier;
  return STYLESHEET_EXTENSIONS.some((extension) => withoutQuery.endsWith(extension));
}

/** What an npm package name segment may hold. An alias like `@/x` or `~/x` matches nothing here. */
const PACKAGE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * The package a bare specifier names: `@scope/name` or `name`, dropping any subpath, so
 * `maplibre-gl/dist/x.css` is asked about as `maplibre-gl`.
 *
 * Nothing for a specifier that was never a package name. A `paths` alias is the case that matters:
 * `@/nowhere` and `~/nowhere` were written to reach this project's own code, so a failure to
 * resolve one is the walk stopping short — not a dependency somebody forgot to install. `#` is
 * Node's own subpath import prefix and points inward for the same reason.
 */
function packageOf(specifier: string): string | undefined {
  const [first, second] = specifier.split("/");
  if (first === undefined || first === "") return undefined;
  if (!first.startsWith("@")) return PACKAGE_SEGMENT.test(first) ? first : undefined;
  const scope = first.slice(1);
  if (!PACKAGE_SEGMENT.test(scope)) return undefined;
  return second !== undefined && PACKAGE_SEGMENT.test(second) ? `${first}/${second}` : undefined;
}

/**
 * The project's own compiler options, chiefly its `paths`, because most of a real project's
 * internal edges are written as aliases rather than relative paths.
 *
 * The config is parsed with a host that never enumerates directories: we want the options, not the
 * file list, and walking the project twice would cost more than the resolution itself.
 */
/**
 * Applied only where the project said nothing. A project with no `tsconfig.json`, or one that
 * leaves resolution to its bundler, still has to resolve `./thing` and a directory index, and the
 * compiler's own default for an unspecified module kind would not.
 */
const DEFAULT_MODULE_RESOLUTION = ts.ModuleResolutionKind.Bundler;

function withFallbacks(options: ts.CompilerOptions): ts.CompilerOptions {
  return {
    ...options,
    moduleResolution: options.moduleResolution ?? DEFAULT_MODULE_RESOLUTION,
    allowJs: options.allowJs ?? true,
  };
}

export function compilerOptionsOf(root: string): ts.CompilerOptions {
  const configPath = join(root, "tsconfig.json");
  if (!existsSync(configPath)) return withFallbacks({});

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined || read.config === undefined) return withFallbacks({});

  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  };
  return withFallbacks(ts.parseJsonConfigFileContent(read.config, host, root).options);
}

/**
 * Resolves specifiers the way the project's own build does, by asking the compiler. Writing this by
 * hand means reimplementing `paths`, extension order and directory indexes, and getting the corner
 * cases wrong on exactly the projects that need them most.
 */
/**
 * @param declaredPackages every package name the manifest declares, or undefined when it could not
 * be read. An absent package is reported either way; this only decides which kind of absence.
 */
/** The path with symlinks resolved, or the path itself where it cannot be read. */
function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function createResolver(
  root: string,
  options?: ts.CompilerOptions,
  declaredPackages?: ReadonlySet<string>,
  /**
   * Workspace members this project links to, as absolute directories, each mapped to the packages
   * its own manifest declares.
   *
   * A linked package resolves through a `node_modules` symlink, so every test below that decides a
   * specifier is external answers yes about it: the compiler marks it an external library import,
   * the resolved path contains `node_modules`, and it sits outside the project root. It is none of
   * those things — it is this repository's own code, and the closure has to walk into it.
   *
   * Its own manifest is what a specifier written inside it has to answer to. `apps/www` never
   * declares `@base-ui/react` — `packages/ui` does, and that is the file the import sits in — so
   * checking the app's manifest for a name a linked package declared reports a dependency the
   * project has as one it is missing.
   */
  linkedPackages: ReadonlyMap<string, ReadonlySet<string> | undefined> = new Map(),
): Resolver {
  const compilerOptions = options ?? compilerOptionsOf(root);
  const canonical = ts.sys.useCaseSensitiveFileNames
    ? (fileName: string) => fileName
    : (fileName: string) => fileName.toLowerCase();
  const cache = ts.createModuleResolutionCache(root, canonical, compilerOptions);
  const inside = root.endsWith(sep) ? root : root + sep;

  /** The manifest a specifier written in `fromFile` has to answer to: its own linked package where it lives inside one, this project's otherwise. */
  const declaredPackagesFor = (fromFile: string): ReadonlySet<string> | undefined => {
    for (const [directory, declared] of linkedPackages) {
      const prefix = directory.endsWith(sep) ? directory : directory + sep;
      if (fromFile === directory || fromFile.startsWith(prefix)) return declared;
    }
    return declaredPackages;
  };

  const declaredKind = (name: string, fromFile: string): Declared => {
    const scoped = declaredPackagesFor(fromFile);
    return scoped === undefined ? "unknown" : scoped.has(name) ? "yes" : "no";
  };

  return (specifier, fromFile) => {
    // Asked before resolution: a stylesheet is an asset whether or not a file answers for it, and
    // asking the compiler about one only makes it fail in a way that means nothing.
    if (isStylesheet(specifier)) return ASSET;

    const { resolvedModule } = ts.resolveModuleName(
      specifier,
      fromFile,
      compilerOptions,
      ts.sys,
      cache,
    );
    // The compiler is asked without a `ts.Program`, so the ambient `declare module "node:fs"`
    // blocks `@types/node` ships are never visible and every built-in lands here. Left as
    // unresolved they made the report overstate its own blindness sixfold. The running Node says
    // what is built in, including the modules that exist only under the `node:` prefix, such as
    // `node:test`. A project module sharing a built-in's name resolved above and never gets here.
    if (!resolvedModule) {
      if (isBuiltin(specifier)) return EXTERNAL;
      const name = packageOf(specifier);
      return name === undefined
        ? UNRESOLVED
        : { kind: "missing-package", name, declared: declaredKind(name, fromFile) };
    }

    const { resolvedFileName, isExternalLibraryImport, extension } = resolvedModule;
    // Asked before every external test, because a linked package fails all of them. Both sides are
    // realpathed first: the compiler resolves through the symlink a package manager wrote, and a
    // macOS temp root is itself a symlink, so comparing the paths as written would have the two
    // disagree about the same directory.
    if (linkedPackages.size > 0) {
      const real = realPathOf(resolvedFileName);
      for (const directory of linkedPackages.keys()) {
        const target = realPathOf(directory);
        const prefix = target.endsWith(sep) ? target : target + sep;
        if (real === target || real.startsWith(prefix)) return { kind: "internal", path: real };
      }
    }
    if (isExternalLibraryImport === true) return EXTERNAL;
    if (resolvedFileName.includes(`${sep}node_modules${sep}`)) return EXTERNAL;
    if (extension === ts.Extension.Dts) return EXTERNAL;
    if (!resolvedFileName.startsWith(inside)) return EXTERNAL;
    return { kind: "internal", path: resolvedFileName };
  };
}
