import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { InstalledNext } from "./project.js";

/** Path of the App Router API reference inside the bundled documentation. */
const API_REFERENCE = join("dist", "docs", "01-app", "03-api-reference");

/** Domains the API reference is organised into, after numeric prefixes are stripped. */
export const DOMAINS = [
  "directives",
  "components",
  "file-conventions",
  "functions",
  "config",
  "cli",
  "adapters",
  /** Pages sitting at the reference root with no domain directory, such as edge and turbopack. */
  "reference",
] as const;

export type Domain = (typeof DOMAINS)[number];

/**
 * Domains that document how to extend or operate Next.js rather than something a project
 * adopts: writing a deployment adapter, the command line, and the runtime overview pages whose
 * adoptable settings live on their own pages. No predicate will ever answer for them, so
 * counting them as our coverage gap reports a debt that can never be paid.
 *
 * Classification is by domain rather than by page id on purpose. A list of ids would need an
 * edit every release, which is the hand-maintained list this tool exists not to have.
 */
const NON_ADOPTABLE_DOMAINS: ReadonlySet<string> = new Set(["adapters", "cli", "reference"]);

/**
 * An unknown domain counts as adoptable. A directory a later version adds then surfaces as this
 * tool's own gap instead of being excluded unseen, which is the direction the report already
 * errs in.
 */
export function isAdoptableDomain(domain: Domain | "unknown"): boolean {
  return !NON_ADOPTABLE_DOMAINS.has(domain);
}

export type SurfaceEntry = {
  /** Stable id: the doc path with numeric ordering prefixes stripped, e.g. `functions/cacheTag`. */
  readonly id: string;
  /** First-level directory, never the immediate parent, so nested pages keep their domain. */
  readonly domain: Domain | "unknown";
  readonly title: string;
  /** API dependency edges Vercel already declares. Recorded now, consumed by later changes. */
  readonly relatedLinks: readonly string[];
  readonly docPath: string;
  /**
   * The same page relative to the bundled API reference root, as shipped:
   * `04-functions/generate-metadata.md`. A reader holding the installed package can open it
   * without the site, and it is the fact the public address below is derived from.
   */
  readonly docRelativePath: string;
  /**
   * Where the public site documents the same page. Derived from the id under a fixed base,
   * never fetched and never verified: the site is a convenience, the bundled page is the truth.
   */
  readonly docUrl: string;
  /** True when frontmatter could not be parsed and the entry was derived from its path alone. */
  readonly frontmatterFailed: boolean;
  /**
   * Lifecycle status the page declares, as written: `legacy`, `experimental`, `canary` and
   * others. Absent when the page declares none, which means an ordinary API rather than an
   * unknown one. Only `legacy` is acted on; the rest are carried and ignored.
   */
  readonly status?: string;
  /**
   * Whether the page documents an API a project can adopt. False for pages about extending or
   * operating Next.js. Governs counting only: a non-adoptable entry is still derived, still
   * addressable, and still joins an authored predicate if one names it.
   */
  readonly adoptable: boolean;
};

export type SurfaceDerivation =
  | {
      readonly status: "available";
      readonly referenceRoot: string;
      readonly entries: readonly SurfaceEntry[];
    }
  | { readonly status: "unavailable"; readonly reason: string };

/** `04-functions` -> `functions`. Ordering prefixes are presentation, not identity. */
function stripOrderPrefix(segment: string): string {
  return segment.replace(/^\d+-/, "");
}

/**
 * The public site's App Router reference. The site has one, and a project cannot want another,
 * so it is a constant rather than configuration.
 */
export const DOCS_BASE = "https://nextjs.org/docs/app/api-reference/";

/**
 * The public address of a derived page. The id already carries the spec's rule — every ordering
 * prefix and the extension stripped — so the address is a formatting of it, not a lookup: a
 * table keyed by id would need maintaining per release, which is what deriving the surface
 * exists to avoid.
 */
export function docUrlOf(id: string): string {
  return `${DOCS_BASE}${id}`;
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkMarkdown(dir: string, found: string[]): void {
  for (const entry of safeReadDir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, found);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
  }
}

type Frontmatter = { title?: unknown; version?: unknown; related?: { links?: unknown } };

type ReadFrontmatter = {
  title?: string;
  status?: string;
  links: string[];
  failed: boolean;
};

function readFrontmatter(path: string): ReadFrontmatter {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { links: [], failed: true };
  }
  if (!raw.startsWith("---")) return { links: [], failed: true };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { links: [], failed: true };

  let parsed: Frontmatter;
  try {
    parsed = parseYaml(raw.slice(3, end)) as Frontmatter;
  } catch {
    return { links: [], failed: true };
  }
  if (!parsed || typeof parsed !== "object") return { links: [], failed: true };

  const title = typeof parsed.title === "string" ? parsed.title : undefined;
  // Kept as written. Mapping it onto a vocabulary of our own would lose a value a later
  // version introduces, and would invite reading `canary` as absent from the release.
  const status = typeof parsed.version === "string" ? parsed.version : undefined;
  const rawLinks = parsed.related?.links;
  const links = Array.isArray(rawLinks)
    ? rawLinks.filter((l): l is string => typeof l === "string")
    : [];
  return {
    links,
    failed: false,
    ...(title === undefined ? {} : { title }),
    ...(status === undefined ? {} : { status }),
  };
}

function toDomain(segment: string): Domain | "unknown" {
  return (DOMAINS as readonly string[]).includes(segment) ? (segment as Domain) : "unknown";
}

/**
 * Derives the API surface from the docs bundled with the installed Next.js.
 * The surface is version-specific by construction: nothing is carried over from
 * another release, so an API absent here can never be suggested.
 */
/**
 * Whether the documentation that shipped with the installed package still states something, on the
 * page an entry was derived from.
 *
 * A claim resting on an instruction the framework gives has to travel with the release that gives
 * it: a version that rewords or withdraws the sentence should take the finding with it rather than
 * leave this repository asserting it. An unreadable page answers no, because a claim nobody can
 * check is not one worth making.
 */
export function documentsInstruction(docPath: string, instruction: string): boolean {
  try {
    return readFileSync(docPath, "utf8").includes(instruction);
  } catch {
    return false;
  }
}

export function deriveSurface(installed: InstalledNext | undefined): SurfaceDerivation {
  if (!installed) {
    return { status: "unavailable", reason: "no installed next package was found" };
  }

  const referenceRoot = join(installed.realPath, API_REFERENCE);
  const files: string[] = [];
  walkMarkdown(referenceRoot, files);

  if (files.length === 0) {
    return {
      status: "unavailable",
      reason:
        `bundled documentation not found at ${API_REFERENCE}; ` +
        `Next.js ${installed.version} predates it or the layout moved`,
    };
  }

  const entries: SurfaceEntry[] = [];
  for (const docPath of files) {
    const segments = relative(referenceRoot, docPath).split(sep);
    const fileName = segments[segments.length - 1];
    if (fileName === undefined || fileName === "index.md") continue;

    const normalised = segments.map(stripOrderPrefix);
    const last = normalised[normalised.length - 1];
    if (last === undefined) continue;
    normalised[normalised.length - 1] = last.replace(/\.md$/, "");

    const frontmatter = readFrontmatter(docPath);
    const id = normalised.join("/");
    // A page with no directory above it documents the reference itself, not a domain.
    const domain: Domain | "unknown" =
      normalised.length === 1 ? "reference" : toDomain(normalised[0] ?? "");

    entries.push({
      id,
      domain,
      title: frontmatter.title ?? (normalised[normalised.length - 1] as string),
      relatedLinks: frontmatter.links,
      docPath,
      docRelativePath: segments.join("/"),
      docUrl: docUrlOf(id),
      frontmatterFailed: frontmatter.failed,
      adoptable: isAdoptableDomain(domain),
      ...(frontmatter.status === undefined ? {} : { status: frontmatter.status }),
    });
  }

  // Sorted here so nothing downstream depends on filesystem enumeration order.
  // Compared by code unit, never with localeCompare: collation varies with the host's
  // ICU data and locale, which would make output non-deterministic across machines.
  entries.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });

  return { status: "available", referenceRoot, entries };
}
