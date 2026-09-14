import { sep } from "node:path";
import { buildCatalog } from "./catalog/build.js";
import { MAPPED_PAGE_KEYS } from "./catalog/config.js";
import type { PredicateContext, Preset } from "./catalog/types.js";
import { buildBoundary } from "./collect/boundary.js";
import { readFlag } from "./collect/config.js";
import {
  BASE_PATH_ENTRY,
  BASE_PATH_INSTRUCTION,
  buildAbsentPrerequisite,
  buildBundlerScope,
  buildConstraints,
  buildDefaultRestatements,
  buildFailingCombination,
  buildMissingModules,
  buildRouteInterceptions,
  buildSegmentConfigRemoved,
  buildUnprefixedAssets,
} from "./collect/constraints.js";
import { buildContrast } from "./collect/contrast.js";
import { readFrameworkDefaults } from "./collect/defaults.js";
import { deriveSurface, documentsInstruction } from "./collect/docs.js";
import { buildGraph } from "./collect/graph.js";
import { buildLedger } from "./collect/ledger.js";
import { EMPTY_JOIN, joinRoutes, readBuildOutput, unavailableReason } from "./collect/output.js";
import { discoverProject } from "./collect/project.js";
import { buildRouteTree } from "./collect/routes.js";
import type { SourceIndex } from "./collect/sources.js";
import { scanSources } from "./collect/sources.js";
import { buildWeights, contrastWeights } from "./collect/weight.js";
import { type CoverageResult, classify } from "./report/classify.js";
import { DEFAULT_PAGE_EXTENSIONS, resolved, type StopReason, unresolved } from "./types.js";

export type { Preset } from "./catalog/types.js";
export type { ClassifiedEntry, CoverageResult } from "./report/classify.js";
export { renderReport, renderStop } from "./report/render.js";
export type { Bucket, CostTier, Resolved, StopReason } from "./types.js";

export type Analysis =
  | {
      readonly kind: "ok";
      readonly result: CoverageResult;
      readonly projectRoot: string;
      readonly version: string;
      /** Set when no surface could be derived, which leaves the result empty. */
      readonly surfaceUnavailable?: string;
    }
  | { readonly kind: "stopped"; readonly reason: StopReason };

/** Runs the whole pipeline: discover, derive, walk, classify. */
export type AnalyseOptions = {
  /** `strict` also runs the opt-in heuristics. Defaults to the conservative preset. */
  readonly preset?: Preset;
  /**
   * A scan of this project made earlier. The scan is by far the most expensive step — seconds
   * against milliseconds for everything built on it — so a caller analysing one project more than
   * once, under two presets or after changing nothing, can pay for it once.
   *
   * It must be a scan of this same project: an index of somewhere else would produce a report
   * about one project's routes and another's files. That is checked rather than trusted, and a
   * scan from elsewhere is ignored in favour of a fresh one.
   */
  readonly sources?: SourceIndex;
};

/**
 * Whether a scan describes the project about to be analysed. Cheap, because a scan that belongs
 * elsewhere shows it in its first file: they are absolute paths under the project root.
 */
function scanIsOf(sources: SourceIndex, root: string): boolean {
  const inside = root.endsWith(sep) ? root : root + sep;
  return sources.files.every((file) => file.path.startsWith(inside));
}

/** Each key a page documents under a name other than its own, pointing back at that page. */
function pagesByConfiguredKey(): ReadonlyMap<string, string> {
  const pages = new Map<string, string>();
  for (const [page, keys] of Object.entries(MAPPED_PAGE_KEYS)) {
    for (const key of keys) pages.set(key, page);
  }
  return pages;
}

export function analyse(startDir: string, options: AnalyseOptions = {}): Analysis {
  const discovery = discoverProject(startDir);
  if (discovery.kind === "stopped") return { kind: "stopped", reason: discovery.reason };

  const { project } = discovery;
  const isFlagEnabled = (flag: string): boolean => {
    const value = readFlag(project.config, flag);
    return value.status === "resolved" && value.value === true;
  };

  const tree = buildRouteTree({
    appDirectory: project.appDirectory.path,
    pageExtensions:
      project.pageExtensions.status === "resolved"
        ? project.pageExtensions.value
        : DEFAULT_PAGE_EXTENSIONS,
    isFlagEnabled,
  });

  const surface = deriveSurface(project.installedNext);
  const catalog = buildCatalog(surface);
  const provided = options.sources;
  const sources =
    provided !== undefined && scanIsOf(provided, project.root)
      ? provided
      : scanSources(project.root);
  // Built once and shared: the boundary report and the `GRAFO` predicates read the same graph.
  const graph = buildGraph(sources);
  // Read once and shared: the contrast and the `BUILD` predicates answer from the same build.
  const build = readBuildOutput(project.root, sources, project.config);
  // Joined once and shared: the contrast draws its claims from this, and a predicate withdrawing a
  // route the build already answered for reads the same join rather than walking the tree again.
  const join =
    build.kind === "read" ? joinRoutes(tree, build.output, project.appDirectory.path) : EMPTY_JOIN;
  const context: PredicateContext = {
    project,
    tree,
    sources,
    graph,
    isFlagEnabled,
    build:
      build.kind === "read"
        ? resolved(build.output)
        : unresolved(unavailableReason(build) ?? "no build was read"),
    join,
  };
  const version =
    project.version.status === "resolved" ? project.version.value : "version unresolved";

  const slotModes = buildConstraints(sources, tree, graph);
  // What the installed Next.js already does by default, which the configuration may restate.
  const restatements = buildDefaultRestatements(
    project.config,
    readFrameworkDefaults(project.installedNext),
    // A finding needs an entry to appear on, and which options have one is a property of the
    // release being analysed rather than a list to keep here.
    new Set(catalog.entries.map((entry) => entry.surface.id)),
    // The page documenting each key, for the four pages whose name is not the key their examples
    // write. Built here because the mapping is the catalog's and the comparison is not.
    pagesByConfiguredKey(),
  );
  // Paths the configuration routes away from, which the project also serves a file at.
  const interceptions = buildRouteInterceptions(project.config, tree);
  // The one constraint whose source is an instruction rather than a default, so it is asked of the
  // documentation that shipped: a release that stops saying it stops this tool saying it too.
  const basePathDoc = catalog.entries.find((entry) => entry.surface.id === BASE_PATH_ENTRY);
  const unprefixed = buildUnprefixedAssets(
    project.config,
    sources,
    basePathDoc !== undefined &&
      documentsInstruction(basePathDoc.surface.docPath, BASE_PATH_INSTRUCTION),
  );
  // Modules the client instrumentation names that the project does not answer for. The one
  // constraint whose fact comes from the project rather than from the installed framework.
  const missing = buildMissingModules(project.config, project.root, project.declaredPackages);
  // Options the documentation scopes to a bundler the project's own scripts never run.
  const scoped = buildBundlerScope(project.config, project.bundlers);
  // The one combination a page names as failing rather than as behaving differently.
  const failing = buildFailingCombination(project.config, project.typeScriptMajor);
  // Segments still exporting a route segment config the configured option removed.
  const removed = buildSegmentConfigRemoved(project.config, tree, sources);
  // An option whose page names a prerequisite this project does not have.
  const absent = buildAbsentPrerequisite(project.config, project.root, project.pageExtensions);
  const constraints = {
    findings: [
      ...slotModes.findings,
      ...restatements.findings,
      ...interceptions.findings,
      ...unprefixed.findings,
      ...missing.findings,
      ...scoped.findings,
      ...failing.findings,
      ...removed.findings,
      ...absent.findings,
    ],
    checked:
      slotModes.checked +
      restatements.checked +
      interceptions.checked +
      unprefixed.checked +
      missing.checked +
      scoped.checked +
      failing.checked +
      removed.checked +
      absent.checked,
    // Defaults the comparison walked past for having no entry to report against. Stated rather
    // than dropped: the checked figure alone describes a narrower walk than the one that ran.
    withoutEntry: restatements.withoutEntry,
    // Readings a check needed and could not make, with what the reader saw. Same rule as the line
    // above, applied to the other way the walk narrows: a reading nobody could make lowers the
    // checked figure, and a lower figure with no reason attached is indistinguishable from a
    // project that declares less. Not only configuration options: an installed package a
    // constraint reads a version from narrows the figure the same way, and said nothing until now.
    unread: [
      ...interceptions.unread,
      ...unprefixed.unread,
      ...missing.unread,
      ...scoped.unread,
      ...failing.unread,
      ...removed.unread,
    ],
  };
  const contrast = buildContrast(
    build,
    tree,
    project.appDirectory.path,
    constraints,
    sources,
    isFlagEnabled("cacheComponents"),
    join,
  );
  // The join is the build's answer to what a route serves, and the weights are filed under it when
  // there is one. Reusing the contrast's spares a second walk of the tree.
  const weights = buildWeights(
    tree,
    graph,
    sources,
    contrast.join.routes.length > 0 ? contrast.join : undefined,
  );
  const weightContrast = contrastWeights(
    weights,
    build.kind === "read" ? build.output.weights.bytesByUrl : new Map(),
    build.kind === "read" ? build.output.weights.reason : unavailableReason(build),
  );

  const preset = options.preset ?? "default";
  const base = {
    kind: "ok",
    result: classify(
      catalog,
      context,
      preset,
      buildLedger(sources, tree, project),
      // The directive examination is observed rather than proven, so the preset decides whether it
      // runs at all: a channel withheld by not running cannot report a file it never looked at.
      buildBoundary(sources, graph, { examineDirectives: preset === "strict" }),
      constraints,
      contrast,
      weights,
      weightContrast,
    ),
    projectRoot: project.root,
    version,
  } as const;

  return surface.status === "unavailable" ? { ...base, surfaceUnavailable: surface.reason } : base;
}
