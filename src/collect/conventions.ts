/**
 * Reserved App Router file names, split by whether a configuration flag has to be on
 * for Next.js to honour them. Gating lives here so route discovery and the catalog
 * cannot disagree about whether a file counts.
 */
import { DEFAULT_PAGE_EXTENSIONS, type Resolved } from "../types.js";

export const ROUTE_CONVENTIONS = [
  "layout",
  "page",
  "loading",
  "error",
  "global-error",
  "not-found",
  "template",
  "default",
  "route",
] as const;

export const FLAG_GATED_CONVENTIONS = {
  forbidden: "experimental.authInterrupts",
  unauthorized: "experimental.authInterrupts",
  "global-not-found": "experimental.globalNotFound",
} as const;

/** Metadata files are matched by their own extensions, not by `pageExtensions`. */
export const METADATA_CONVENTIONS = [
  "sitemap",
  "robots",
  "manifest",
  "icon",
  "apple-icon",
  "opengraph-image",
  "twitter-image",
] as const;

export type RouteConvention = (typeof ROUTE_CONVENTIONS)[number];
export type FlagGatedConvention = keyof typeof FLAG_GATED_CONVENTIONS;
export type MetadataConvention = (typeof METADATA_CONVENTIONS)[number];
export type ConventionName = RouteConvention | FlagGatedConvention | MetadataConvention;

const ALL_CONVENTIONS: readonly string[] = [
  ...ROUTE_CONVENTIONS,
  ...Object.keys(FLAG_GATED_CONVENTIONS),
  ...METADATA_CONVENTIONS,
];

export function isConventionName(name: string): name is ConventionName {
  return ALL_CONVENTIONS.includes(name);
}

export function requiredFlagFor(name: ConventionName): string | undefined {
  return name in FLAG_GATED_CONVENTIONS
    ? FLAG_GATED_CONVENTIONS[name as FlagGatedConvention]
    : undefined;
}

/**
 * Matched case-sensitively on purpose: Next.js will not pick up `Page.tsx`, so
 * neither do we. A name that differs only in casing is reported as a near-miss
 * instead of being silently accepted or silently dropped.
 */
export function conventionOf(
  fileName: string,
  pageExtensions: readonly string[],
): { name: ConventionName; casingMismatch: boolean } | undefined {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) return undefined;
  const base = fileName.slice(0, lastDot);
  const extension = fileName.slice(lastDot + 1);

  if (isConventionName(base)) {
    const isMetadata = (METADATA_CONVENTIONS as readonly string[]).includes(base);
    if (isMetadata || pageExtensions.includes(extension)) {
      return { name: base, casingMismatch: false };
    }
    return undefined;
  }

  const lowered = base.toLowerCase();
  if (isConventionName(lowered) && pageExtensions.includes(extension)) {
    return { name: lowered, casingMismatch: true };
  }
  return undefined;
}

/**
 * The page extensions as a plain list, falling back to the documented default where the project's
 * own value could not be read. The same fallback route tree construction applies, kept here rather
 * than shared so that this module answers the question without its callers each deciding.
 */
function extensionsOrDefault(pageExtensions: Resolved<readonly string[]>): readonly string[] {
  return pageExtensions.status === "resolved" ? pageExtensions.value : DEFAULT_PAGE_EXTENSIONS;
}

/**
 * Where a proxy file may sit, as path segments so a consumer joins them against the project root.
 *
 * Derived from the extensions the project resolves rather than named in advance, because Next.js
 * builds the same candidates by iterating `pageExtensions`: a list written here would be a second
 * opinion about what a proxy is called. It was one — four names ending in `.ts` and `.js` — and a
 * project whose proxy was a `.tsx` file was reported as having none at all.
 *
 * Here for the reason this module exists: the catalog reports the convention as present or absent
 * from exactly these names, and a constraint that resolved a proxy differently could say a project
 * has none on the same run the report files the convention under Used. Every reader takes the
 * candidates from here, so that cannot happen through one of them being updated and not the others.
 */
export function proxyFiles(
  pageExtensions: Resolved<readonly string[]>,
): readonly (readonly string[])[] {
  return extensionsOrDefault(pageExtensions).flatMap((extension) => [
    [`proxy.${extension}`],
    ["src", `proxy.${extension}`],
  ]);
}

/**
 * The files Next.js loads from the project root on its own, outside the route tree: the proxy, the
 * name it replaced, and the instrumentation hook. Derived like `proxyFiles` and for its reason.
 *
 * Read by selections asking whether the framework runs a file at all. A candidate the project does
 * not have costs nothing there, and one missing from this list would drop what it imports.
 */
export function rootEntryFiles(
  pageExtensions: Resolved<readonly string[]>,
): readonly (readonly string[])[] {
  return [
    ...proxyFiles(pageExtensions),
    ...extensionsOrDefault(pageExtensions).flatMap((extension) =>
      ["middleware", "instrumentation"].flatMap((name) => [
        [`${name}.${extension}`],
        ["src", `${name}.${extension}`],
      ]),
    ),
  ];
}
