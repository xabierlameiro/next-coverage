import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Resolved, resolved, unresolved } from "../types.js";
import type { InstalledNext } from "./project.js";

/**
 * The two lists the installed Next.js applies whether or not a project mentions them.
 *
 * Neither file is a documented interface: one is compiled output holding an array literal
 * inside a function, the other is JSON carrying comments and a trailing comma. So every read
 * is defensive and every result is `Resolved` — a list that cannot be read disables the rules
 * resting on it rather than falling back to a copy, which would be wrong for exactly the
 * version the reader is running.
 */

/** Where the server-external list ships, as a path inside the installed package. */
const EXTERNAL_LIST = join("dist", "lib", "server-external-packages.jsonc");

/**
 * Where the built-in cacheLife profiles and the default config ship. Two objects in one module,
 * each read by anchoring on its own name.
 */
const CACHE_PROFILES = join("dist", "esm", "server", "config-shared.js");

/** Where the default-transpiled list ships. Plain JSON, unlike the other two. */
const TRANSPILED_LIST = join("dist", "lib", "default-transpiled-packages.json");

/** Where the optimized-imports list ships. The ESM build is the one carrying the literal. */
const OPTIMIZE_LIST = join("dist", "esm", "server", "config.js");

/** Where the expression naming the crawlers served blocking metadata ships. */
const HTML_BOTS = join("dist", "shared", "lib", "router", "utils", "html-bots.js");

/** Where the installed package declares the metrics `webVitalsAttribution` accepts. */
const WEB_VITALS_LIST = join("dist", "shared", "lib", "utils.d.ts");

/**
 * The identifier the array literal follows. Anchoring on it rather than on the option name
 * matters: the option is mentioned in several files and several times in this one, and only
 * this spot is the merge of the user's value with the defaults.
 */
const OPTIMIZE_ANCHOR = "userProvidedOptimizePackageImports,";

/**
 * Both lists hold ~75 entries across every version measured. A read yielding far fewer has
 * found something other than the list — a refactor, a different minifier, a renamed anchor —
 * and reporting that as a short list would turn every declared package into a finding.
 */
const PLAUSIBLE_FLOOR = 40;

/**
 * The expression holds twenty-six alternatives across every version measured. A read yielding far
 * fewer has matched something other than the list.
 */
const BOT_ALTERNATIVES_FLOOR = 15;

export type FrameworkDefaults = {
  /** Packages Next.js already optimizes imports for. */
  readonly optimizedImports: Resolved<ReadonlySet<string>>;
  /** Packages Next.js already treats as server-external. */
  readonly serverExternals: Resolved<ReadonlySet<string>>;
  /** Packages Next.js already transpiles. One entry today, so it carries its own floor. */
  readonly transpiled: Resolved<ReadonlySet<string>>;
  /** The `cacheLife` profile names Next.js defines without being asked. */
  readonly cacheProfiles: Resolved<ReadonlySet<string>>;
  /**
   * The scalar values Next.js applies to each option when a project sets none. Scalars only:
   * an option defaulting to an object holds a shape, and a value and a shape are different
   * questions.
   */
  readonly optionDefaults: Resolved<ReadonlyMap<string, string | number | boolean | null>>;
};

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function checkPlausible(
  names: readonly string[],
  what: string,
  path: string,
): Resolved<ReadonlySet<string>> {
  if (names.length < PLAUSIBLE_FLOOR) {
    return unresolved(
      `${what} yielded ${names.length} packages from ${path}, ` +
        `far below the ${PLAUSIBLE_FLOOR} the list is known to hold; treating it as unreadable`,
    );
  }
  return resolved(new Set(names));
}

/**
 * Reads the server-external list. Quoted strings at line starts skip the comments without a
 * JSONC parser and without a dependency — `JSON.parse` refuses this file outright, over the
 * trailing comma alone.
 */
export function readServerExternals(
  installed: InstalledNext | undefined,
): Resolved<ReadonlySet<string>> {
  if (!installed) return unresolved("no installed next package to read the default list from");

  const path = join(installed.realPath, EXTERNAL_LIST);
  const raw = read(path);
  if (raw === undefined) {
    return unresolved(
      `the default server-external list was not found at ${EXTERNAL_LIST}; ` +
        `Next.js ${installed.version} predates it or the layout moved`,
    );
  }

  const names = [...raw.matchAll(/^\s*"([^"]+)"/gm)].flatMap((m) => m[1] ?? []);
  return checkPlausible(names, "reading the default server-external list", EXTERNAL_LIST);
}

/**
 * Reads the optimized-imports list out of the compiled config module, taking the quoted strings
 * between the anchor and the first closing bracket after it.
 *
 * The returned set holds the entries as the release writes them, and some of them are subpaths:
 * 16.3.0 names `react-icons/si` and `react-icons/fc` individually and never `react-icons`. A caller
 * reducing an import to its bare package name before asking this set will therefore miss every
 * package listed that way, and report imports the release already optimises as ones to add.
 */
export function readOptimizedImports(
  installed: InstalledNext | undefined,
): Resolved<ReadonlySet<string>> {
  if (!installed) return unresolved("no installed next package to read the default list from");

  const path = join(installed.realPath, OPTIMIZE_LIST);
  const raw = read(path);
  if (raw === undefined) {
    return unresolved(
      `the default optimized-imports list was not found at ${OPTIMIZE_LIST}; ` +
        `Next.js ${installed.version} predates it or the layout moved`,
    );
  }

  const start = raw.indexOf(OPTIMIZE_ANCHOR);
  if (start === -1) {
    return unresolved(
      `the default optimized-imports list was not located in ${OPTIMIZE_LIST}: ` +
        `Next.js ${installed.version} no longer spells '${OPTIMIZE_ANCHOR}' beside it`,
    );
  }

  const end = raw.indexOf("])", start);
  if (end === -1) {
    return unresolved(
      `the default optimized-imports list in ${OPTIMIZE_LIST} did not terminate as expected`,
    );
  }

  // A package name holds neither a comma nor a newline. Without excluding them the pattern
  // also matches the separator between two entries — `',\n            '` — which reads as a
  // 76th package and, being identical every time, collapses 75 names into 45.
  const names = [
    ...raw.slice(start + OPTIMIZE_ANCHOR.length, end).matchAll(/'([^'\n,]+)'/g),
  ].flatMap((m) => m[1] ?? []);
  return checkPlausible(names, "reading the default optimized-imports list", OPTIMIZE_LIST);
}

/**
 * Reads the default-transpiled list. It holds a single package today, so the floor the other two
 * use would reject it — but an empty array still has to read as unreadable rather than as a list
 * with nothing on it, since "Next transpiles nothing by default" is a claim this file cannot make.
 */
export function readTranspiled(
  installed: InstalledNext | undefined,
): Resolved<ReadonlySet<string>> {
  if (!installed) return unresolved("no installed next package to read the default list from");

  const path = join(installed.realPath, TRANSPILED_LIST);
  const raw = read(path);
  if (raw === undefined) {
    return unresolved(
      `the default transpiled list was not found at ${TRANSPILED_LIST}; ` +
        `Next.js ${installed.version} predates it or the layout moved`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unresolved(`the default transpiled list at ${TRANSPILED_LIST} is not valid JSON`);
  }

  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
    return unresolved(`the default transpiled list at ${TRANSPILED_LIST} is not an array of names`);
  }
  if (parsed.length === 0) {
    return unresolved(
      `the default transpiled list at ${TRANSPILED_LIST} is empty; treating it as unreadable ` +
        "rather than as a claim that Next.js transpiles nothing",
    );
  }
  return resolved(new Set(parsed as string[]));
}

/**
 * Reads the built-in `cacheLife` profile names. They are the keys of an object literal, so the
 * extraction takes identifiers followed by a colon between the anchor and the closing brace —
 * narrower than the quoted-string patterns the other readers use, because these keys are bare.
 */
export function readCacheProfiles(
  installed: InstalledNext | undefined,
): Resolved<ReadonlySet<string>> {
  if (!installed) return unresolved("no installed next package to read the default profiles from");

  const path = join(installed.realPath, CACHE_PROFILES);
  const raw = read(path);
  if (raw === undefined) {
    return unresolved(
      `the built-in cacheLife profiles were not found at ${CACHE_PROFILES}; ` +
        `Next.js ${installed.version} predates them or the layout moved`,
    );
  }

  const start = raw.indexOf("cacheLife: {");
  if (start === -1) {
    return unresolved(
      `the built-in cacheLife profiles were not located in ${CACHE_PROFILES}: ` +
        `Next.js ${installed.version} no longer spells 'cacheLife: {' beside them`,
    );
  }

  // The object ends where its braces balance. Anything after it — `cacheHandlers`,
  // `experimental`, `staleTimes` — is a sibling config key, and a name-and-brace pattern run to
  // the end of the file would collect those as profiles.
  const open = start + "cacheLife: ".length;
  let depth = 0;
  let close = -1;
  for (let i = open; i < raw.length; i += 1) {
    if (raw[i] === "{") depth += 1;
    else if (raw[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) {
    return unresolved(
      `the built-in cacheLife profiles in ${CACHE_PROFILES} did not terminate as expected`,
    );
  }

  // Each profile is `name: { stale, revalidate, expire }`, so the opening brace after the name
  // is what distinguishes a profile from the numeric fields inside one.
  const profiles = [...raw.slice(open + 1, close).matchAll(/(\w+):\s*\{/g)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);

  // `default` alone means the object was found and the rest was not.
  if (profiles.length < 3) {
    return unresolved(
      `reading the built-in cacheLife profiles from ${CACHE_PROFILES} yielded ${profiles.length}; ` +
        "treating it as unreadable rather than as a project with almost no profiles",
    );
  }
  return resolved(new Set(profiles));
}

/** The literal forms a scalar default is written in, and what each parses to. */
function scalarOf(raw: string): string | number | boolean | null | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * The body of a named object literal, cut where its braces balance. Anything after it belongs to
 * the module rather than to the object, and a pattern run to the end of the file collects it.
 */
function objectBody(raw: string, anchor: string): string | undefined {
  const start = raw.indexOf(anchor);
  if (start === -1) return undefined;
  const open = raw.indexOf("{", start);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < raw.length; i += 1) {
    if (raw[i] === "{") depth += 1;
    else if (raw[i] === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(open + 1, i);
    }
  }
  return undefined;
}

/**
 * Reads the scalar defaults Next.js applies when a project sets nothing. A project writing one of
 * these has written a line the framework was already applying — a fact about the configuration,
 * which is why it is read here rather than asserted anywhere.
 *
 * Two levels, and no more. A scalar at the top level is keyed by its own name; one inside an
 * option whose default is an object is keyed by the dotted path that option gives it, so
 * `typescript.ignoreBuildErrors` addresses the same place on both sides of the comparison — the
 * configuration reader already resolves a dotted path through nested objects.
 *
 * Nothing deeper is read. One level is where the three object-defaulted options put their scalars,
 * and a general walk would be a different reader with a different way of being wrong.
 */
export function readOptionDefaults(
  installed: InstalledNext | undefined,
): Resolved<ReadonlyMap<string, string | number | boolean | null>> {
  if (!installed) return unresolved("no installed next package to read the default config from");

  const path = join(installed.realPath, CACHE_PROFILES);
  const raw = read(path);
  if (raw === undefined) {
    return unresolved(
      `the default config was not found at ${CACHE_PROFILES}; ` +
        `Next.js ${installed.version} predates it or the layout moved`,
    );
  }

  const body = objectBody(raw, "export const defaultConfig");
  if (body === undefined) {
    return unresolved(
      `the default config was not located in ${CACHE_PROFILES}: ` +
        `Next.js ${installed.version} no longer spells 'export const defaultConfig' beside it`,
    );
  }

  const defaults = new Map<string, string | number | boolean | null>();
  for (const [, name, literal] of body.matchAll(
    /^ {4}(\w+): (true|false|'[^']*'|null|-?\d+)(?=,|$)/gm,
  )) {
    if (name === undefined || literal === undefined) continue;
    const value = scalarOf(literal);
    if (value !== undefined) defaults.set(name, value);
  }

  // The scalars one level inside an option that defaults to an object. Cut by the same brace
  // balance the outer object is, so a nested object stops the reading rather than flattening into
  // its parent's namespace.
  //
  // No container is left out, `experimental` included. It was, on the ground that a finding keyed
  // under it would have no catalog entry to hang on — true of the container's own name, and the
  // wrong place to fix it: the keys inside have pages under their own names, and which entry a
  // finding lands on is the comparison's decision rather than this reader's. The exclusion also
  // carried a claim this reader never made good on, that the options inside were already compared
  // under their own name. They were not compared at all: 75 scalar defaults sit in there on 16.3.0
  // and 67 on 16.2.x, against the 28 this map held.
  for (const [, option] of body.matchAll(/^ {4}(\w+): \{/gm)) {
    if (option === undefined) continue;
    const nested = objectBody(body, `    ${option}: {`);
    if (nested === undefined) continue;
    for (const [, key, literal] of nested.matchAll(
      /^ {8}(\w+): (true|false|'[^']*'|null|-?\d+)(?=,|$)/gm,
    )) {
      if (key === undefined || literal === undefined) continue;
      const value = scalarOf(literal);
      if (value !== undefined) defaults.set(`${option}.${key}`, value);
    }
  }

  // Far fewer than the object holds means the shape moved and the pattern found something else.
  // A floor, not a ceiling: it was written against a map of 28 and the map is now a hundred, and
  // the number that would say the release moved is still a handful rather than a proportion.
  if (defaults.size < 10) {
    return unresolved(
      `reading the default config from ${CACHE_PROFILES} yielded ${defaults.size} scalar options; ` +
        "treating it as unreadable rather than as a release that dropped its defaults",
    );
  }
  return resolved(defaults);
}

export function readFrameworkDefaults(installed: InstalledNext | undefined): FrameworkDefaults {
  return {
    optimizedImports: readOptimizedImports(installed),
    serverExternals: readServerExternals(installed),
    transpiled: readTranspiled(installed),
    cacheProfiles: readCacheProfiles(installed),
    optionDefaults: readOptionDefaults(installed),
  };
}

/**
 * The metric names the installed release accepts for `webVitalsAttribution`, read from the
 * declaration file rather than from a list kept here — the same move every other default reader
 * makes, and the reason a release that adds a metric does not need an edit.
 *
 * Unresolved where the declaration is not found, so a condition written against it goes quiet
 * rather than reporting every configured metric as unaccepted.
 */
export function readWebVitals(installed: InstalledNext | undefined): Resolved<ReadonlySet<string>> {
  if (!installed) return unresolved("no installed next package to read the accepted metrics from");

  const raw = read(join(installed.realPath, WEB_VITALS_LIST));
  if (raw === undefined) {
    return unresolved(
      `the accepted web-vitals list was not found at ${WEB_VITALS_LIST}; ` +
        `Next.js ${installed.version} predates it or the layout moved`,
    );
  }

  const declaration = /WEB_VITALS:\s*readonly\s*\[([^\]]*)\]/.exec(raw)?.[1];
  if (declaration === undefined) {
    return unresolved(`the WEB_VITALS declaration was not found in ${WEB_VITALS_LIST}`);
  }

  const names = [...declaration.matchAll(/"([^"]+)"/g)].flatMap((m) => m[1] ?? []);
  return checkPlausible(names, "reading the accepted web-vitals metrics", WEB_VITALS_LIST);
}

/**
 * The expression the installed release matches a crawler's user agent against to decide whether it
 * is served blocking metadata rather than streaming metadata.
 *
 * Read from the installed package rather than copied here, like every other framework fact. A
 * release that stops exporting it takes the condition resting on it with it: a list maintained in
 * this repository would be wrong for exactly the release the reader is running, which is the
 * failure every reader in this file is written to avoid.
 */
export function readHtmlLimitedBots(installed: InstalledNext | undefined): Resolved<RegExp> {
  if (!installed) return unresolved("no installed next package to read the bot expression from");

  const raw = read(join(installed.realPath, HTML_BOTS));
  if (raw === undefined) {
    return unresolved(
      `the HTML-limited-bot expression was not found at ${HTML_BOTS}; ` +
        `Next.js ${installed.version} predates it or the layout moved`,
    );
  }

  // One line, one literal. The pattern is greedy up to the last slash so an expression carrying a
  // character class does not truncate at the first one inside it.
  const literal = /HTML_LIMITED_BOT_UA_RE\s*=\s*\/(.*)\/([a-z]*)\s*;/.exec(raw);
  const source = literal?.[1];
  if (source === undefined) {
    return unresolved(
      `the HTML_LIMITED_BOT_UA_RE declaration was not found in ${HTML_BOTS}: ` +
        `Next.js ${installed.version} no longer spells it as a regular-expression literal`,
    );
  }

  // The shipped expression names two dozen crawlers. Far fewer means the pattern found something
  // other than the list, and matching a project's agents against that would report every one of
  // them as uncovered.
  if (source.split("|").length < BOT_ALTERNATIVES_FLOOR) {
    return unresolved(
      `the HTML-limited-bot expression in ${HTML_BOTS} names ` +
        `${source.split("|").length} alternatives, far below the ${BOT_ALTERNATIVES_FLOOR} ` +
        "the list is known to hold; treating it as unreadable",
    );
  }

  try {
    return resolved(new RegExp(source, literal?.[2] ?? ""));
  } catch {
    return unresolved(`the HTML-limited-bot expression in ${HTML_BOTS} did not compile`);
  }
}
