import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Trimmed copies of the manifests two real builds left behind, one per Next.js minor. They are
 * recorded rather than built: the shapes are what the tests are about, and producing them for
 * real is minutes of build per run for a file that states the same thing exactly.
 *
 * Each snapshot keeps one entry of every distinct shape its source manifest held, plus a few
 * routes the build listed and did not prerender — the case a contrast has to decide from an
 * absence.
 */
export const SNAPSHOT_VERSIONS = ["16.2.6", "16.3.0"] as const;

export type SnapshotVersion = (typeof SNAPSHOT_VERSIONS)[number];

const here = dirname(fileURLToPath(import.meta.url));

export function snapshotPath(version: SnapshotVersion, file: string): string {
  return join(here, "manifests", version, file);
}

/** Parsed fresh on every call, so a test may mutate what it gets without reaching the next one. */
export function readSnapshot(version: SnapshotVersion, file: string): unknown {
  return JSON.parse(readFileSync(snapshotPath(version, file), "utf8"));
}

export type BuildFiles = {
  /** Omitted means no `BUILD_ID`, which is how an interrupted build leaves the directory. */
  readonly buildId?: string;
  /** Omitted means the manifest is absent, not empty. */
  readonly prerender?: unknown;
  readonly appPaths?: unknown;
  /** Written under `.next/diagnostics/`, where the build puts it. */
  readonly bundleStats?: unknown;
};

/**
 * Writes a `.next` directory under `root`, holding exactly the files given. Absence is a case
 * the reader has to answer for, so a test builds the directory it means rather than deleting
 * from a complete one.
 */
export function writeBuild(root: string, files: BuildFiles, dist = ".next"): string {
  const next = join(root, dist);
  mkdirSync(next, { recursive: true });
  if (files.buildId !== undefined) writeFileSync(join(next, "BUILD_ID"), files.buildId);
  if (files.prerender !== undefined) {
    writeFileSync(join(next, "prerender-manifest.json"), JSON.stringify(files.prerender));
  }
  if (files.appPaths !== undefined) {
    writeFileSync(join(next, "app-path-routes-manifest.json"), JSON.stringify(files.appPaths));
  }
  if (files.bundleStats !== undefined) {
    const diagnostics = join(next, "diagnostics");
    mkdirSync(diagnostics, { recursive: true });
    writeFileSync(join(diagnostics, "route-bundle-stats.json"), JSON.stringify(files.bundleStats));
  }
  return next;
}

/** A complete, current build directory carrying one version's snapshots. */
export function writeSnapshotBuild(root: string, version: SnapshotVersion): string {
  return writeBuild(root, {
    buildId: `snapshot-${version}`,
    prerender: readSnapshot(version, "prerender-manifest.json"),
    appPaths: readSnapshot(version, "app-path-routes-manifest.json"),
    bundleStats: readSnapshot(version, "route-bundle-stats.json"),
  });
}
