/**
 * The authored half of the functions domain: which module each documented symbol comes from.
 * The symbol name itself is NOT here — it is derived from the doc page's frontmatter title,
 * which matches the exported identifier on 40 of the 41 pages.
 *
 * Anchoring on the module is what stops a project's own `headers` or `after` helper from
 * being mistaken for the framework's.
 */

export type DetectionShape =
  /** Imported by name from `module`. */
  | { readonly kind: "import"; readonly module: string; readonly acceptTypeOnly?: true }
  /** The page documents a module rather than a symbol; any import of it counts. */
  | { readonly kind: "module"; readonly module: string }
  /** Exported by name from a file the route tree recognises as a convention. */
  | { readonly kind: "export" }
  /** The framework's extension of the global, detected by its `next` option. */
  | { readonly kind: "fetch" };

const importedFrom = (module: string): DetectionShape => ({ kind: "import", module });

export const FUNCTION_SHAPES: Readonly<Record<string, DetectionShape>> = {
  "functions/after": importedFrom("next/server"),
  "functions/connection": importedFrom("next/server"),
  "functions/userAgent": importedFrom("next/server"),
  "functions/next-response": importedFrom("next/server"),
  // NextRequest is a type, so a type-only import is the genuine use rather than a near-miss.
  "functions/next-request": { kind: "import", module: "next/server", acceptTypeOnly: true },

  "functions/cacheLife": importedFrom("next/cache"),
  "functions/cacheTag": importedFrom("next/cache"),
  "functions/io": importedFrom("next/cache"),
  "functions/refresh": importedFrom("next/cache"),
  "functions/revalidatePath": importedFrom("next/cache"),
  "functions/revalidateTag": importedFrom("next/cache"),
  "functions/updateTag": importedFrom("next/cache"),
  "functions/unstable_cache": importedFrom("next/cache"),
  "functions/unstable_noStore": importedFrom("next/cache"),

  "functions/cookies": importedFrom("next/headers"),
  "functions/headers": importedFrom("next/headers"),
  "functions/draft-mode": importedFrom("next/headers"),

  "functions/not-found": importedFrom("next/navigation"),
  "functions/forbidden": importedFrom("next/navigation"),
  "functions/unauthorized": importedFrom("next/navigation"),
  "functions/redirect": importedFrom("next/navigation"),
  "functions/permanentRedirect": importedFrom("next/navigation"),
  "functions/unstable_rethrow": importedFrom("next/navigation"),
  "functions/use-router": importedFrom("next/navigation"),
  "functions/use-pathname": importedFrom("next/navigation"),
  "functions/use-search-params": importedFrom("next/navigation"),
  "functions/use-params": importedFrom("next/navigation"),
  "functions/use-selected-layout-segment": importedFrom("next/navigation"),
  "functions/use-selected-layout-segments": importedFrom("next/navigation"),

  "functions/catchError": importedFrom("next/error"),
  "functions/image-response": importedFrom("next/og"),
  "functions/use-link-status": importedFrom("next/link"),
  "functions/use-offline": importedFrom("next/offline"),
  "functions/use-report-web-vitals": importedFrom("next/web-vitals"),

  "functions/next-root-params": { kind: "module", module: "next/root-params" },

  "functions/generate-metadata": { kind: "export" },
  "functions/generate-viewport": { kind: "export" },
  "functions/generate-static-params": { kind: "export" },
  "functions/generate-sitemaps": { kind: "export" },
  "functions/generate-image-metadata": { kind: "export" },

  "functions/fetch": { kind: "fetch" },
};

/** Functions whose presence means a mutation was invalidated somehow. */
export const INVALIDATION_SYMBOLS = [
  "revalidateTag",
  "revalidatePath",
  "updateTag",
  "refresh",
] as const;
