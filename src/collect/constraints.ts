import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Resolved } from "../types.js";
import type { NextConfigSource } from "./config.js";
import { readFlag, readFlagList, readFlagPresence, readRuleSources } from "./config.js";
import { proxyFiles } from "./conventions.js";
import type { FrameworkDefaults } from "./defaults.js";
import type { ModuleGraph } from "./graph.js";
import { reachableFrom } from "./graph.js";
import { attributeLiteral } from "./jsx.js";
import type { Bundler } from "./project.js";
import type { RouteNode, RouteTree } from "./routes.js";
import type { SourceIndex } from "./sources.js";
import { callsResolvedTo, productionFiles, SOURCE_EXTENSIONS } from "./sources.js";

/**
 * The APIs whose presence makes a segment render dynamically. Named here rather than derived,
 * because the constraint is about rendering mode and not about which functions exist: a later
 * release adding one is a change to this list, made deliberately.
 */
const DYNAMIC_APIS: readonly (readonly [module: string, imported: string])[] = [
  ["next/headers", "headers"],
  ["next/headers", "cookies"],
  ["next/headers", "draftMode"],
  ["next/server", "connection"],
];

/** The entry this channel's only constraint belongs to. */
export const SLOT_MODE_ENTRY = "file-conventions/parallel-routes";

/** A slot read as static, and the sibling whose dynamism decides its rendering mode. */
export type StaticSlot = {
  readonly slot: string;
  readonly directory: string;
};

/** Slots of one segment share a rendering mode, so a static slot beside a dynamic one is not
 * prerendered. */
export type SlotModeFinding = {
  readonly kind: "slot-mode";
  /** The entry whose documentation states the rule. */
  readonly entry: string;
  /** The segment the slots share. */
  readonly segment: string;
  readonly staticSlots: readonly StaticSlot[];
  /** One dynamic sibling, named as the cause. */
  readonly cause: string;
  /** How the cause was decided: its own file, or a module it reaches. */
  readonly causeChain: readonly string[];
  /** Dynamic siblings beyond the one named, so the reader knows the cause is not the only one. */
  readonly otherDynamic: number;
};

/**
 * The configuration names a package the installed Next.js already handles by default.
 *
 * It reports the overlap and what the framework does, and stops there. A project may pin a
 * package deliberately, against a release dropping it from the default list, and which of those
 * a given line is cannot be read from the source.
 */
export type RestatesDefaultFinding = {
  readonly kind: "restates-default";
  readonly entry: string;
  /** The configuration key, as the project spells it. */
  readonly option: string;
  /** The declared packages that are already on the default list. */
  readonly packages: readonly string[];
  /** What the framework does with them, in its own terms. */
  readonly whatNextDoes: string;
  /** The file the declaration was read from. */
  readonly source: string;
};

/**
 * The configuration routes a request away from a path the project also serves. The rule wins: the
 * `page` or `route` at that path is never reached, so the file is written and unreachable.
 *
 * Reported as what the framework does, not as a mistake. A project may be retiring the route
 * deliberately and have left the file in place, and which of those a given pair is cannot be read
 * from the source.
 */
export type InterceptedRouteFinding = {
  readonly kind: "intercepted-route";
  readonly entry: string;
  /** The configuration key, as the project spells it. */
  readonly option: string;
  /** Each pattern that matches a served path, with the route it takes. */
  readonly routes: readonly { readonly pattern: string; readonly serves: string }[];
  /** The file the rules were read from. */
  readonly source: string;
  /** Rules whose pattern could not be read, counted rather than hidden. */
  readonly unread: number;
};

/**
 * The project set an option whose documentation asks for that value to be written into something
 * the framework does not write it into for you, and the source does not carry it.
 *
 * This is the one constraint sourced from an instruction rather than from a default. `basePath` is
 * applied to a `next/link` href automatically and to a `next/image` src by the project, and the
 * page says so — so an image source without the prefix is requested without it.
 */
export type UnprefixedAssetFinding = {
  readonly kind: "unprefixed-asset";
  readonly entry: string;
  /** The configuration key, as the project spells it. */
  readonly option: string;
  /** The configured value the documentation asks to be written by hand. */
  readonly prefix: string;
  /** Each attribute value that does not carry it, with the file writing it. */
  readonly assets: readonly { readonly file: string; readonly value: string }[];
  /** The file the option was read from. */
  readonly source: string;
};

/**
 * The configuration names a module for the framework to import, and the project does not hold it.
 *
 * The only constraint whose fact comes from the project rather than from the installed Next.js.
 * Reporting an absence is normally refused here, because a bundler resolves what a scan does not —
 * so this one is bounded to the two shapes the option's page documents, and says nothing about any
 * other.
 */
export type MissingModuleFinding = {
  readonly kind: "missing-module";
  readonly entry: string;
  /** The configuration key, as the project spells it. */
  readonly option: string;
  /** Each configured entry the project does not answer, with why it was looked for that way. */
  readonly modules: readonly { readonly value: string; readonly as: "path" | "package" }[];
  /** The file the option was read from. */
  readonly source: string;
  /** Entries that were not string literals, counted rather than hidden. */
  readonly unread: number;
};

/**
 * A configured option, or a value of one, that the documentation scopes to a bundler no script of
 * the project runs. The setting is written and the framework never reads it.
 *
 * Not a claim that the line is wrong: a project may be carrying it for a bundler it means to
 * return to, and which case a given line is cannot be read from the manifest.
 */
export type BundlerScopeFinding = {
  readonly kind: "bundler-scope";
  readonly entry: string;
  /** Each setting the project's bundlers do not reach, with the scope its page gives it. */
  readonly settings: readonly {
    readonly option: string;
    /** Present when the scope belongs to the value rather than to the option. */
    readonly value?: string;
    readonly scope: Bundler;
  }[];
  /** What the project's scripts run, so a reader can see both halves of the comparison. */
  readonly running: readonly Bundler[];
  readonly source: string;
};

/**
 * A configured value together with an installed version the documentation names as failing.
 *
 * The only finding in this channel whose consequence is that a build does not complete, and it
 * stays in the same register for that: a project migrating may hold the combination knowingly, so
 * the report says what the framework does with it rather than that the configuration is wrong.
 */
export type FailingCombinationFinding = {
  readonly kind: "failing-combination";
  readonly entry: string;
  readonly option: string;
  /** The package and version the documentation names, as the finding found them. */
  readonly withPackage: string;
  readonly majorInstalled: number;
  /** What the page says happens, in its own terms. */
  readonly consequence: string;
  readonly source: string;
};

/**
 * A configured option the documentation says removes a route segment config, together with a
 * segment the project still exports that name from.
 *
 * The second finding in this channel whose consequence is a build that does not complete, and it
 * keeps the same register: a project part-way through the migration this option asks for holds the
 * combination knowingly, and which case a given segment is cannot be read from the source.
 */
export type SegmentConfigRemovedFinding = {
  readonly kind: "segment-config-removed";
  readonly entry: string;
  /** The configuration key, as the project spells it. */
  readonly option: string;
  /** Each segment still exporting one of the removed names, with the name it exports. */
  readonly segments: readonly { readonly file: string; readonly exported: string }[];
  /** What the documentation says happens, in its own terms. */
  readonly consequence: string;
  /** The file the option was read from. */
  readonly source: string;
};

/**
 * A configured option whose page names a prerequisite the project does not have, so the option
 * governs something that is never brought into existence.
 *
 * Not that the line is wrong: a project may be configuring ahead of a file it is about to add.
 */
export type AbsentPrerequisiteFinding = {
  readonly kind: "absent-prerequisite";
  readonly entry: string;
  readonly option: string;
  /** What the page names as the condition for the option applying, in its own terms. */
  readonly needs: string;
  readonly source: string;
};

export type ConstraintFinding =
  | SlotModeFinding
  | RestatesDefaultFinding
  | InterceptedRouteFinding
  | UnprefixedAssetFinding
  | MissingModuleFinding
  | BundlerScopeFinding
  | FailingCombinationFinding
  | SegmentConfigRemovedFinding
  | AbsentPrerequisiteFinding;

export type ConstraintReport = {
  readonly findings: readonly ConstraintFinding[];
  /** How many constraints were examined, so an empty report reads as checked rather than absent. */
  readonly checked: number;
  /**
   * Framework defaults the comparison passed over because no catalog entry holds the identifier
   * their finding would carry. Counted rather than dropped: a release carries defaults for options
   * it documents no page for, and without this the checked figure describes a narrower walk than
   * the one that ran.
   */
  readonly withoutEntry: number;
  /**
   * Configuration options a check needed and could not read, with the reason. The other way the
   * walk narrows, and the one that says nothing on its own: a default with no page to report
   * against is the release's doing, while an option written in a shape this reader does not enter
   * is the project's, and only the second is worth telling the project about.
   */
  readonly unread: readonly UnreadReading[];
};

/** What `buildConstraints` produces: this constraint yields one kind of finding, and says so. */
export type SlotModeReport = {
  readonly findings: readonly SlotModeFinding[];
  readonly checked: number;
};

export const EMPTY_CONSTRAINTS: ConstraintReport = {
  findings: [],
  checked: 0,
  withoutEntry: 0,
  unread: [],
};

/**
 * Documented rules the project's code contradicts. One constraint today: slots of one segment
 * share a rendering mode, so a static slot beside a dynamic one is not prerendered.
 *
 * The finding is what the framework does as a result, never a claim that the code is wrong. A
 * project may have chosen this deliberately, and from outside that is not knowable.
 */
export function buildConstraints(
  index: SourceIndex,
  tree: RouteTree,
  graph: ModuleGraph,
): SlotModeReport {
  const dynamicCallers = filesCallingDynamicApis(index);
  const findings: SlotModeFinding[] = [];

  for (const node of tree.nodes) {
    const slots = node.children.filter((child) => child.kind === "slot");
    // One slot cannot disagree with a sibling it does not have.
    if (slots.length < 2) continue;

    const modes = slots.map((slot) => ({ slot, ...modeOf(slot, dynamicCallers, graph) }));
    const statics = modes.filter((mode) => !mode.dynamic);
    const dynamics = modes.filter((mode) => mode.dynamic);
    // All of one kind satisfies the constraint, whichever kind it is.
    if (statics.length === 0 || dynamics.length === 0) continue;

    const cause = dynamics[0];
    if (cause === undefined) continue;
    findings.push({
      kind: "slot-mode",
      entry: SLOT_MODE_ENTRY,
      segment: node.directory,
      staticSlots: statics.map((mode) => ({
        slot: mode.slot.slotName ?? mode.slot.dirName,
        directory: mode.slot.directory,
      })),
      cause: cause.slot.slotName ?? cause.slot.dirName,
      causeChain: cause.chain,
      otherDynamic: dynamics.length - 1,
    });
  }

  // Sorted so repeated runs match, the way the boundary report sorts its leaks.
  findings.sort((a, b) => (a.segment === b.segment ? 0 : a.segment < b.segment ? -1 : 1));
  return { findings, checked: 1 };
}

/**
 * Every file calling one of the dynamic APIs, gathered once for the whole project. Scanning per
 * slot would repeat this work for each of them and answer the same question.
 *
 * A call counts only when it resolves to the framework import: a project's own `headers` is its
 * own function, and reading it as Next.js's would decide the rendering mode from a name.
 */
function filesCallingDynamicApis(index: SourceIndex): ReadonlySet<string> {
  const callers = new Set<string>();
  for (const [module, imported] of DYNAMIC_APIS) {
    for (const { file } of callsResolvedTo(index, module, imported)) {
      if (!file.isTest) callers.add(file.path);
    }
  }
  return callers;
}

/**
 * A slot is dynamic when any of its own convention files, or anything they reach, calls one of the
 * APIs. The chain kept is the one from the convention file down to the calling module, so a reader
 * can see which import decided it — a chain of one means the file decided it itself.
 */
function modeOf(
  slot: RouteNode,
  dynamicCallers: ReadonlySet<string>,
  graph: ModuleGraph,
): { dynamic: boolean; chain: readonly string[] } {
  for (const entry of conventionFilesUnder(slot)) {
    for (const [path, chain] of reachableFrom(graph, entry)) {
      if (dynamicCallers.has(path)) return { dynamic: true, chain };
    }
  }
  return { dynamic: false, chain: [] };
}

/** The slot's own convention files and those of everything below it, which all render inside it. */
function conventionFilesUnder(slot: RouteNode): string[] {
  const files: string[] = [];
  const walk = (node: RouteNode): void => {
    for (const convention of node.conventions) {
      if (convention.skippedForFlag === undefined) files.push(convention.file);
    }
    for (const child of node.children) walk(child);
  };
  walk(slot);
  return files;
}

/** The two options whose declared packages can be compared against a list Next.js already applies. */
const DEFAULTED_OPTIONS: readonly {
  readonly entry: string;
  readonly paths: readonly string[];
  readonly whatNextDoes: string;
  readonly list: (defaults: FrameworkDefaults) => Resolved<ReadonlySet<string>>;
}[] = [
  {
    entry: "config/next-config-js/optimizePackageImports",
    paths: ["optimizePackageImports", "experimental.optimizePackageImports"],
    whatNextDoes: "Next.js already optimizes imports for",
    list: (defaults) => defaults.optimizedImports,
  },
  {
    entry: "config/next-config-js/serverExternalPackages",
    paths: ["serverExternalPackages", "experimental.serverComponentsExternalPackages"],
    whatNextDoes: "Next.js already treats as server-external",
    list: (defaults) => defaults.serverExternals,
  },
  {
    entry: "config/next-config-js/transpilePackages",
    paths: ["transpilePackages", "experimental.transpilePackages"],
    whatNextDoes: "Next.js already transpiles",
    list: (defaults) => defaults.transpiled,
  },
];

/**
 * Options set to the scalar value the framework already applies. A project writing
 * `poweredByHeader: true` has written a line that changes nothing — reported as a fact about the
 * configuration, never as a line to delete: pinning a value against a release that changes it is
 * a reason, and one indistinguishable from the other in the source.
 */
/**
 * The page a finding about `option` belongs on, or nothing where the release documents none.
 *
 * The key first, the container second. A nested key is a fact about whatever page documents it, and
 * for most of them that is a page under the key's own name — `experimental.taint` belongs on
 * `taint`. Where no page carries the key, the container is the page: nothing is named
 * `ignoreBuildErrors`, and `typescript.ignoreBuildErrors` is a fact about `typescript`.
 *
 * The mapping of pages to the keys they document is tried last, and only last. It exists for the
 * four pages whose name is not their key, and routing every finding through a table written for
 * that purpose would make it the arbiter of a question it was not asked.
 */
function entryForOption(
  option: string,
  entryIds: ReadonlySet<string>,
  pagesByKey: ReadonlyMap<string, string>,
): string | undefined {
  const segments = option.split(".");
  for (const candidate of [segments.at(-1), segments[0]]) {
    if (candidate === undefined) continue;
    const entry = `${CONFIG_OPTION_PAGE}${candidate}`;
    if (entryIds.has(entry)) return entry;
  }
  const page = pagesByKey.get(option);
  if (page === undefined) return undefined;
  const entry = `${CONFIG_OPTION_PAGE}${page}`;
  return entryIds.has(entry) ? entry : undefined;
}

function optionsRestatingTheirDefault(
  config: NextConfigSource,
  defaults: Resolved<ReadonlyMap<string, string | number | boolean | null>>,
  entryIds: ReadonlySet<string>,
  pagesByKey: ReadonlyMap<string, string>,
): { findings: RestatesDefaultFinding[]; withoutEntry: number } {
  if (defaults.status !== "resolved") return { findings: [], withoutEntry: 0 };
  const findings: RestatesDefaultFinding[] = [];
  let withoutEntry = 0;

  for (const [option, fallback] of defaults.value) {
    // A finding needs somewhere to appear. The installed release carries defaults for options it
    // documents no page for, and one of those would raise the contradiction count and then match
    // no entry when the report looked for where to print it.
    const entry = entryForOption(option, entryIds, pagesByKey);
    if (entry === undefined) {
      withoutEntry += 1;
      continue;
    }
    const declared = readFlag(config, option);
    if (declared.status !== "resolved" || declared.value === undefined) continue;
    if (declared.value !== fallback) continue;
    findings.push({
      kind: "restates-default",
      entry,
      option,
      packages: [String(fallback)],
      whatNextDoes: "Next.js already applies",
      source: config.path,
    });
  }
  return { findings, withoutEntry };
}

/**
 * Packages the configuration declares that the installed Next.js already handles by default.
 *
 * Every path to silence is deliberate: an unresolved default list has no authority to compare
 * against, and an array whose contents did not resolve holds names that were never read. Both
 * report nothing rather than guessing, which is the same rule the rest of this file follows.
 */
export function buildDefaultRestatements(
  config: NextConfigSource | undefined,
  defaults: FrameworkDefaults,
  entryIds: ReadonlySet<string>,
  /**
   * The page documenting each key, for the pages whose name is not the key their examples write.
   * Passed in rather than read here: the mapping belongs to the catalog, and this module does not
   * reach into it.
   */
  pagesByKey: ReadonlyMap<string, string> = new Map(),
): {
  readonly findings: readonly RestatesDefaultFinding[];
  readonly checked: number;
  readonly withoutEntry: number;
} {
  if (config === undefined) return { findings: [], checked: 0, withoutEntry: 0 };
  const findings: RestatesDefaultFinding[] = [];
  // Examined only where there was something to examine against. A default list that did not
  // resolve was not checked, and counting it would report a check that never happened.
  let checked = 0;

  for (const option of DEFAULTED_OPTIONS) {
    const list = option.list(defaults);
    if (list.status !== "resolved") continue;
    checked += 1;

    for (const path of option.paths) {
      // A branched list is taken as written. The question here is whether the project declares a
      // package the framework already handles, and a package named in either branch is declared —
      // the contradiction says the documentation names this combination, never that the project is
      // wrong, so it stays true of whichever branch writes it.
      const declared = readFlagList(config, path);
      if (declared.status !== "resolved" || declared.value.values.length === 0) continue;

      const already = declared.value.values.filter((name) => list.value.has(name));
      if (already.length === 0) continue;

      findings.push({
        kind: "restates-default",
        entry: option.entry,
        option: path,
        packages: already,
        whatNextDoes: option.whatNextDoes,
        source: config.path,
      });
    }
  }

  // The scalar comparison is one constraint over every option carrying a readable default, not
  // one per option: a reader asking "does my config restate a default" asks it once.
  const scalars = optionsRestatingTheirDefault(
    config,
    defaults.optionDefaults,
    entryIds,
    pagesByKey,
  );
  if (defaults.optionDefaults.status === "resolved") checked += 1;

  return {
    findings: [...findings, ...scalars.findings],
    checked,
    withoutEntry: scalars.withoutEntry,
  };
}

/**
 * The routing options whose rules take a request away from the path it named. `headers` is not
 * one: it adds headers to a response the route still produces.
 */
const INTERCEPTING_OPTIONS: readonly { readonly option: string; readonly entry: string }[] = [
  { option: "redirects", entry: "config/next-config-js/redirects" },
  { option: "rewrites", entry: "config/next-config-js/rewrites" },
];

/** The conventions that answer a request. A layout at the path serves nothing on its own. */
const SERVING_CONVENTIONS = ["page", "route"] as const;

/**
 * A pattern this can compare against a path. Next.js patterns carry named parameters, wildcards
 * and inline regular expressions, and matching those against the route tree is a second matcher
 * to keep correct — so a pattern holding any of them is left alone rather than approximated.
 */
function isPlainPath(pattern: string): boolean {
  return pattern.startsWith("/") && !/[:*?(){}[\]]/.test(pattern);
}

/** The paths the project answers requests at, by URL. */
function servedPaths(tree: RouteTree): Map<string, string> {
  const served = new Map<string, string>();
  for (const node of tree.nodes) {
    const serving = node.conventions.find(
      (convention) =>
        SERVING_CONVENTIONS.some((name) => name === convention.name) &&
        convention.skippedForFlag === undefined,
    );
    if (serving) served.set(node.urlPath, serving.file);
  }
  return served;
}

/**
 * Rules that route a request away from a path the project also serves.
 *
 * The comparison is deliberately narrow. A rule matching a path nothing serves is the ordinary
 * case — that is what a redirect is for — and a pattern with parameters is not compared at all.
 * What is left is the pair that cannot be intentional by construction: a literal path with a rule
 * on it and a file behind it.
 */
/**
 * What each bundler-scoped option, or value, is scoped to — taken from the sentence on its own page
 * rather than decided here.
 *
 * Data rather than parsed prose: a reader that mined these labels out of the pages would produce a
 * claim per page with nothing checking it. Seven entries from seven sentences is the smaller
 * promise, and a release rewording one is a documented change rather than a silent one.
 */
/**
 * The directory the reference gives each option its own page under. Repeated here rather than
 * imported from the catalog: the catalog reads this module, and the arrow only points one way.
 */
const CONFIG_OPTION_PAGE = "config/next-config-js/";

const BUNDLER_SCOPED: readonly {
  readonly option: string;
  /** Set where the scope belongs to one value of the option rather than to the option itself. */
  readonly value?: string;
  readonly scope: Bundler;
}[] = [
  { option: "useLightningcss", scope: "webpack" },
  { option: "turbopackChunking", scope: "turbopack" },
  { option: "turbopackMemoryEviction", scope: "turbopack" },
  { option: "turbopackLocalPostcssConfig", scope: "turbopack" },
  { option: "cssChunking", value: "false", scope: "webpack" },
  { option: "cssChunking", value: "strict", scope: "webpack" },
  { option: "cssChunking", value: "graph", scope: "turbopack" },
];

/**
 * Settings the project's own scripts never let the framework read.
 *
 * An option is inert only where no script runs a bundler its scope covers: one that is ignored by
 * the build and read by the dev server is not inert, and reporting it would be wrong for half the
 * project. Where the bundler is unresolved nothing is reported at all — the absence of a
 * declaration is not a declaration of the default.
 */
/**
 * Whether a configuration can answer for an option at all, over the paths it may be written at.
 * A path that resolves — whether or not the option is there — is an answer; one that does not is
 * the absence of one.
 *
 * The distinction is the whole point of the checked figure: a configuration this tool could not
 * read is not a configuration that sets nothing, and counting it as checked reports a check that
 * never happened. The constraints that already got this right guard on the value they read; these
 * guarded on the configuration existing, which is a different question.
 */
function anyPathReadable(
  config: NextConfigSource,
  paths: readonly string[],
  read: (config: NextConfigSource, path: string) => { readonly status: string },
): boolean {
  return paths.some((path) => read(config, path).status === "resolved");
}

export function buildBundlerScope(
  config: NextConfigSource | undefined,
  bundlers: Resolved<ReadonlySet<Bundler>>,
): {
  readonly findings: readonly BundlerScopeFinding[];
  readonly checked: number;
  readonly unread: readonly UnreadReading[];
} {
  // Two causes shared one guard here, the way they did in the combination check before it was
  // split. A configuration that does not resolve is a cause above every constraint resting on it
  // and is stated once where it happens. The bundlers are this check's own reading: the scope in
  // every row is a bundler, so not knowing which ones the project runs is what stops it, and
  // nothing else in the report says that.
  if (config === undefined) return { findings: [], checked: 0, unread: [] };
  if (bundlers.status !== "resolved") {
    return {
      findings: [],
      checked: 0,
      unread: [
        {
          subject: "bundlers",
          reason:
            "the bundlers this project runs could not be read, so the options scoped to one were not checked",
        },
      ],
    };
  }

  // Nothing here can be answered from a configuration whose values do not resolve. Silent on
  // purpose, on the rule the combination check follows: this guard cannot tell an option written
  // in a shape it does not read from one the project never wrote, and naming an option on the
  // second reading would describe writing the file does not contain.
  const readable = BUNDLER_SCOPED.some((scoped) =>
    anyPathReadable(
      config,
      [scoped.option, `experimental.${scoped.option}`],
      scoped.value === undefined ? readFlagPresence : readFlag,
    ),
  );
  if (!readable) return { findings: [], checked: 0, unread: [] };

  const running = [...bundlers.value];
  const settings: { option: string; value?: string; scope: Bundler }[] = [];
  for (const scoped of BUNDLER_SCOPED) {
    if (running.includes(scoped.scope)) continue;
    const paths = [scoped.option, `experimental.${scoped.option}`];
    if (scoped.value === undefined) {
      const present = paths.some((path) => {
        const found = readFlagPresence(config, path);
        return found.status === "resolved" && found.value;
      });
      if (present) settings.push({ option: scoped.option, scope: scoped.scope });
      continue;
    }
    // A value-scoped row concerns what was written, so the value has to be read rather than its
    // presence: an option set to something else is not the setting this row is about.
    const written = paths
      .map((path) => readFlag(config, path))
      .find((value) => value.status === "resolved" && value.value !== undefined);
    if (written?.status !== "resolved") continue;
    if (String(written.value) === scoped.value) {
      settings.push({ option: scoped.option, value: scoped.value, scope: scoped.scope });
    }
  }

  // One finding per option, because a finding hangs off the catalog entry it names and these
  // settings belong to different pages. `cssChunking` can contribute at most one row, so grouping
  // by option never merges two claims about the same page into one that reads as either.
  const byOption = new Map<string, typeof settings>();
  for (const setting of settings) {
    const held = byOption.get(setting.option) ?? [];
    held.push(setting);
    byOption.set(setting.option, held);
  }

  return {
    findings: [...byOption].map(([option, rows]) => ({
      kind: "bundler-scope" as const,
      entry: `${CONFIG_OPTION_PAGE}${option}`,
      settings: rows,
      running,
      source: config.path,
    })),
    checked: 1,
    unread: [],
  };
}

/** The entry the missing-module constraint belongs to. */
export const CLIENT_INJECT_ENTRY = "config/next-config-js/instrumentationClientInject";

/**
 * Modules the client instrumentation names that the project does not answer for.
 *
 * An absence is normally not this tool's to claim: the bundler resolves through `exports` maps and
 * `tsconfig` paths that no scan models. What makes it claimable here is that the option's page
 * documents exactly two shapes — a path relative to the root, and a bare package name resolved
 * from the project's own `node_modules` — and both are answerable without resolving anything. An
 * entry in any other shape is not judged.
 */
export function buildMissingModules(
  config: NextConfigSource | undefined,
  root: string,
  declaredPackages: Resolved<ReadonlySet<string>>,
): {
  readonly findings: readonly MissingModuleFinding[];
  readonly checked: number;
  readonly unread: readonly UnreadReading[];
} {
  if (config === undefined) return { findings: [], checked: 0, unread: [] };

  // A branched list is taken as written, which is what reaches this check on a real project:
  // `voidcraft-labs/commcare-nova` turns the option on by environment. A module named in either
  // branch must exist for that branch to run, so naming a missing one is right under both.
  const listed = readFlagList(config, "instrumentationClientInject");
  // A call or a variable is not a list this tool can read, and an unread list holds no absences.
  // The reading was attempted on this option by name, so the reason is attributable to it: that
  // is what separates this from the guard that only asks whether any path was readable.
  if (listed.status !== "resolved") {
    return {
      findings: [],
      checked: 0,
      unread: [
        {
          subject: "instrumentationClientInject",
          reason: reasonNaming("instrumentationClientInject", listed.reason),
        },
      ],
    };
  }
  if (listed.value.values.length === 0 && listed.value.skipped === 0) {
    return { findings: [], checked: 1, unread: [] };
  }

  const modules: { value: string; as: "path" | "package" }[] = [];
  for (const value of listed.value.values) {
    if (value.startsWith(".")) {
      const candidate = join(root, value);
      const found =
        existsSync(candidate) ||
        SOURCE_EXTENSIONS.some((extension) => existsSync(`${candidate}${extension}`));
      if (!found) modules.push({ value, as: "path" });
      continue;
    }
    // A manifest this tool could not read judges nothing: absent from a list we never had is not
    // absent from the project.
    if (declaredPackages.status !== "resolved") continue;
    const installed = existsSync(join(root, "node_modules", value));
    if (!declaredPackages.value.has(value) && !installed) {
      modules.push({ value, as: "package" });
    }
  }

  return modules.length === 0
    ? { findings: [], checked: 1, unread: [] }
    : {
        findings: [
          {
            kind: "missing-module",
            entry: CLIENT_INJECT_ENTRY,
            option: "instrumentationClientInject",
            modules,
            source: config.path,
            unread: listed.value.skipped,
          },
        ],
        checked: 1,
        unread: [],
      };
}

/** The entry the absent-prerequisite constraint belongs to. */
export const PROXY_BODY_ENTRY = "config/next-config-js/proxyClientMaxBodySize";

/**
 * The proxy body limit, set on a project with no proxy to buffer for.
 *
 * *"When proxy is used, Next.js automatically clones the request body and buffers it in memory"* —
 * so without a proxy there is no clone, and the bound governs nothing. The value is not read: any
 * limit on a buffer that is never allocated is the same finding.
 *
 * The file names come from `proxyFiles`, which the catalog resolves the convention from. Reading
 * them anywhere else would let this say a project has no proxy on the same run the report files
 * that convention under Used — which is why the page extensions arrive here rather than being
 * defaulted locally.
 */
export function buildAbsentPrerequisite(
  config: NextConfigSource | undefined,
  root: string,
  pageExtensions: Resolved<readonly string[]>,
): { readonly findings: readonly AbsentPrerequisiteFinding[]; readonly checked: number } {
  if (config === undefined) return { findings: [], checked: 0 };

  const paths = ["proxyClientMaxBodySize", "experimental.proxyClientMaxBodySize"];
  if (!anyPathReadable(config, paths, readFlagPresence)) return { findings: [], checked: 0 };

  const configured = paths.some((path) => {
    const found = readFlagPresence(config, path);
    return found.status === "resolved" && found.value;
  });
  if (!configured) return { findings: [], checked: 1 };
  if (proxyFiles(pageExtensions).some((segments) => existsSync(join(root, ...segments)))) {
    return { findings: [], checked: 1 };
  }

  return {
    findings: [
      {
        kind: "absent-prerequisite",
        entry: PROXY_BODY_ENTRY,
        option: "proxyClientMaxBodySize",
        needs: "a proxy, which is what makes the framework buffer a request body at all",
        source: config.path,
      },
    ],
    checked: 1,
  };
}

/** The entry the failing-combination constraint belongs to. */
export const TYPESCRIPT_CLI_ENTRY = "config/next-config-js/useTypeScriptCli";

/**
 * The opt-out the page names as failing, together with the TypeScript it names it for.
 *
 * *"If you opt out while using TypeScript 7, `next build` exits because the TypeScript JavaScript
 * compiler API is unavailable."* Both halves are read rather than assumed: an absent or unreadable
 * value, or a TypeScript this tool could not resolve, is not half a finding.
 */
export function buildFailingCombination(
  config: NextConfigSource | undefined,
  typeScriptMajor: Resolved<number>,
): {
  readonly findings: readonly FailingCombinationFinding[];
  readonly checked: number;
  readonly unread: readonly UnreadReading[];
} {
  // Two causes used to share one guard, and sharing it is what made this check silent. A
  // configuration that does not resolve is a cause above every constraint resting on it, stated
  // once where it happens; naming the package here too would report several failures where there
  // was one. An unresolved TypeScript is this check's own, and nothing else says it.
  if (config === undefined) return { findings: [], checked: 0, unread: [] };
  if (typeScriptMajor.status !== "resolved") {
    return {
      findings: [],
      checked: 0,
      unread: [
        {
          subject: "typescript",
          reason:
            "the installed typescript could not be read, so the combination it is half of was not checked",
        },
      ],
    };
  }

  const paths = ["useTypeScriptCli", "experimental.useTypeScriptCli"];
  if (!anyPathReadable(config, paths, readFlag)) return { findings: [], checked: 0, unread: [] };

  const optedOut = paths
    .map((path) => readFlag(config, path))
    .find((value) => value.status === "resolved" && value.value !== undefined);
  // Configured is not enough: the failure the page names is the opt-out, and a project asking for
  // the default with `true` is asking for the thing that works.
  if (optedOut?.status !== "resolved" || optedOut.value !== false) {
    return { findings: [], checked: 1, unread: [] };
  }
  if (typeScriptMajor.value < 7) return { findings: [], checked: 1, unread: [] };

  return {
    findings: [
      {
        kind: "failing-combination",
        entry: TYPESCRIPT_CLI_ENTRY,
        option: "useTypeScriptCli",
        withPackage: "typescript",
        majorInstalled: typeScriptMajor.value,
        consequence:
          "next build exits, because the compiler API it falls back to is unavailable there",
        source: config.path,
      },
    ],
    checked: 1,
    unread: [],
  };
}

/** The entry the removed-segment-config constraint belongs to. */
export const CACHE_COMPONENTS_ENTRY = "config/next-config-js/cacheComponents";

/**
 * The route segment configs Next 16 removes when `cacheComponents` is on.
 *
 * Named here rather than parsed out of the docs. The rule lives in a Version History table —
 * *"`dynamic`, `dynamicParams`, `revalidate`, and `fetchCache` removed when Cache Components is
 * enabled"* — and reading a list of four out of prose is how a reworded row empties the constraint
 * without anyone noticing. A test asserts the installed docs still name these four, so a release
 * that changes them fails loudly instead.
 */
export const REMOVED_BY_CACHE_COMPONENTS: readonly string[] = [
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
];

/**
 * Segments still exporting a route segment config the configuration removed.
 *
 * The export is the whole reading: the documentation says a segment that *exports* one of these
 * errors, whatever it assigns. That is also what keeps `revalidate` and `dynamicParams` in scope,
 * whose values are a number and a boolean and are not among the literals this tool reads.
 */
export function buildSegmentConfigRemoved(
  config: NextConfigSource | undefined,
  tree: RouteTree,
  sources: SourceIndex,
): {
  readonly findings: readonly SegmentConfigRemovedFinding[];
  readonly checked: number;
  readonly unread: readonly UnreadReading[];
} {
  // A configuration that does not resolve is the cause above every check resting on it, stated
  // where it happens rather than again here.
  if (config === undefined) return { findings: [], checked: 0, unread: [] };

  const enabled = readFlag(config, "cacheComponents");
  if (enabled.status !== "resolved") {
    return {
      findings: [],
      checked: 0,
      unread: [
        {
          subject: "cacheComponents",
          reason:
            "'cacheComponents' could not be read, so what it removes from a segment was not checked",
        },
      ],
    };
  }
  // Off is an answer, and the answer is that the removal has not happened. The check ran.
  if (enabled.value !== true) return { findings: [], checked: 1, unread: [] };

  const segments: { file: string; exported: string }[] = [];
  for (const node of tree.nodes) {
    for (const convention of node.conventions) {
      if (convention.skippedForFlag !== undefined) continue;
      const exported = sources.byPath.get(convention.file)?.exportedNames ?? [];
      for (const name of REMOVED_BY_CACHE_COMPONENTS) {
        if (exported.includes(name)) segments.push({ file: convention.file, exported: name });
      }
    }
  }
  if (segments.length === 0) return { findings: [], checked: 1, unread: [] };

  return {
    findings: [
      {
        kind: "segment-config-removed",
        entry: CACHE_COMPONENTS_ENTRY,
        option: "cacheComponents",
        segments,
        consequence:
          "next build stops on each of them, because the option removes that segment config",
        source: config.path,
      },
    ],
    checked: 1,
    unread: [],
  };
}

/** The entry the documented-instruction constraint belongs to. */
export const BASE_PATH_ENTRY = "config/next-config-js/basePath";

/**
 * The instruction `basePath`'s own page gives, matched on the words that carry it rather than on
 * the whole paragraph. A release rewording the sentence ends the finding, which is the safe
 * direction: the claim is the framework's, and this tool stops making it when the framework does.
 */
export const BASE_PATH_INSTRUCTION = "add the `basePath` in front of `src`";

/**
 * Image sources written without the prefix the option sets, where the documentation says the
 * project has to write it in. `next/link` gets the prefix applied for it and `next/image` does
 * not — that asymmetry is the whole finding, and it comes from the page rather than from here.
 *
 * Only the element the documentation names is read. A raw `<img>` carries the same consequence,
 * but saying so would be this tool's inference standing in a finding that claims to report the
 * framework's instruction.
 */
export function buildUnprefixedAssets(
  config: NextConfigSource | undefined,
  sources: SourceIndex,
  instructionStands: boolean,
): {
  readonly findings: readonly UnprefixedAssetFinding[];
  readonly checked: number;
  readonly unread: readonly UnreadReading[];
} {
  // Neither is a reading that failed. No configuration is nothing to read, and an instruction the
  // installed release no longer gives is a check that does not apply to it.
  if (config === undefined || !instructionStands) return { findings: [], checked: 0, unread: [] };

  const configured = readFlag(config, "basePath");
  // An option this tool could not read is not one it can compare a source against.
  if (configured.status !== "resolved") {
    return {
      findings: [],
      checked: 0,
      unread: [{ subject: "basePath", reason: reasonNaming("basePath", configured.reason) }],
    };
  }
  const prefix = configured.value;
  if (typeof prefix !== "string" || prefix === "") return { findings: [], checked: 1, unread: [] };

  const assets: { file: string; value: string }[] = [];
  for (const file of productionFiles(sources)) {
    for (const element of file.jsxElements) {
      if (element.tag !== "Image") continue;
      const src = attributeLiteral(element, "src");
      // A computed source is unread, here as everywhere: the prefix may well be in the expression.
      if (src === undefined || !src.startsWith("/")) continue;
      if (src === prefix || src.startsWith(`${prefix}/`)) continue;
      assets.push({ file: file.path, value: src });
    }
  }

  return assets.length === 0
    ? { findings: [], checked: 1, unread: [] }
    : {
        findings: [
          {
            kind: "unprefixed-asset",
            entry: BASE_PATH_ENTRY,
            option: "basePath",
            prefix,
            assets,
            source: config.path,
          },
        ],
        checked: 1,
        unread: [],
      };
}

/**
 * A reading a check needed and could not make, with the reason the reader gave.
 *
 * The reason is carried rather than counted because the count is the part that misleads: a project
 * whose `redirects` is written in a shape this reader does not enter reports a lower checked figure
 * and nothing else, which reads exactly like a project that declares fewer options. Naming what was
 * not read turns a silently narrower walk into something the reader can act on.
 *
 * The subject is not always a configuration option. A constraint resting on the version of an
 * installed package narrows the figure the same way when that package does not resolve, and a
 * reader told only that the figure fell cannot tell the two apart.
 */
export type UnreadReading = {
  readonly subject: string;
  readonly reason: string;
};

/**
 * The reason as the report will print it. The renderer prints the reason and nothing else, so it
 * has to carry the option's name on its own.
 *
 * Two ways it arrives without one. A reader describing only the shape it saw — "value is computed,
 * not a literal" — says nothing about which option it was looking at. And a failure one level up,
 * where the configuration as a whole did not resolve, is inherited by every option that rests on
 * it: printed bare, two checks that could not run read as one sentence said twice. Prefixing fixes
 * both. What it must not do is stutter over a reason that already names the option, which the
 * readers below this one produce whenever they can, so the prefix goes on only when it is missing.
 */
export function reasonNaming(option: string, reason: string): string {
  return reason.startsWith(`'${option}'`) ? reason : `'${option}' could not be read: ${reason}`;
}

export function buildRouteInterceptions(
  config: NextConfigSource | undefined,
  tree: RouteTree,
): {
  readonly findings: readonly InterceptedRouteFinding[];
  readonly checked: number;
  readonly unread: readonly UnreadReading[];
} {
  if (config === undefined) return { findings: [], checked: 0, unread: [] };

  const served = servedPaths(tree);
  const findings: InterceptedRouteFinding[] = [];
  const unread: UnreadReading[] = [];
  let checked = 0;

  for (const { option, entry } of INTERCEPTING_OPTIONS) {
    const declared = readRuleSources(config, option);
    // An option written in a shape the reader cannot enter was not checked. Counting it would
    // report a check that never happened, which is the rule the other constraints follow. The
    // reason it gave travels with it, so the check that did not run says so instead of thinning
    // the figure without explanation.
    if (declared.status !== "resolved") {
      unread.push({ subject: option, reason: declared.reason });
      continue;
    }
    checked += 1;
    if (declared.value.values.length === 0 && declared.value.skipped === 0) continue;

    const routes = declared.value.values
      .filter(isPlainPath)
      .map((pattern) => ({ pattern, serves: served.get(pattern) }))
      .filter((pair): pair is { pattern: string; serves: string } => pair.serves !== undefined);

    if (routes.length === 0) continue;
    findings.push({
      kind: "intercepted-route",
      entry,
      option,
      routes,
      source: config.path,
      unread: declared.value.skipped,
    });
  }

  return { findings, checked, unread };
}
