/** Detection cost tier declared by every authored predicate set. */
export type CostTier = "FS" | "AST" | "GRAFO" | "BUILD";

/** Where a catalog entry ends up in the report. */
export type Bucket = "used" | "would-apply" | "not-applicable" | "not-evaluated";

/**
 * A value the tool either read with confidence or deliberately refused to guess.
 * Unresolved is a first-class state: it disables dependent rules instead of
 * letting them fall back to an assumed default.
 */
export type Resolved<T> =
  | { readonly status: "resolved"; readonly value: T }
  | { readonly status: "unresolved"; readonly reason: string };

export function resolved<T>(value: T): Resolved<T> {
  return { status: "resolved", value };
}

export function unresolved<T>(reason: string): Resolved<T> {
  return { status: "unresolved", reason };
}

export function isResolved<T>(r: Resolved<T>): r is { status: "resolved"; value: T } {
  return r.status === "resolved";
}

/** Why analysis stopped before producing a report. Never an error exit. */
export type StopReason =
  | { readonly kind: "no-project"; readonly from: string }
  | { readonly kind: "no-app-router"; readonly root: string; readonly hasPagesRouter: boolean }
  /**
   * The directory is a monorepo root holding Next apps of its own, and none of them is what was
   * asked about. Distinct from `no-project`, which says there is nothing here: there is, and the
   * caller pointed one level too high. Naming the apps is the whole value — a reader told "no
   * Next.js project found" at the root of a repository full of them learns nothing.
   */
  | {
      readonly kind: "workspace-root";
      readonly root: string;
      readonly apps: readonly { readonly directory: string; readonly declares?: string }[];
    }
  /**
   * The directory declares no workspace and is no project, and Next apps sit below it anyway.
   *
   * Distinct from `workspace-root` because nothing here declares a workspace: a repository whose
   * app is `web/` under a root holding no manifest is not a workspace root, and saying it is would
   * put a claim in the output that the filesystem does not make. The value is the same — naming
   * where a report can be produced — but the reason it can be named is not.
   */
  | {
      readonly kind: "apps-below";
      readonly from: string;
      readonly apps: readonly { readonly directory: string; readonly declares?: string }[];
    };

export const DEFAULT_PAGE_EXTENSIONS: readonly string[] = ["js", "jsx", "ts", "tsx", "mjs"];
