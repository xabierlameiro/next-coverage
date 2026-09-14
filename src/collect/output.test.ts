import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readSnapshot,
  SNAPSHOT_VERSIONS,
  type SnapshotVersion,
  writeBuild,
  writeSnapshotBuild,
} from "../../test-support/manifests.js";
import { DEFAULT_PAGE_EXTENSIONS } from "../types.js";
import { readNextConfig } from "./config.js";
import { joinRoutes, readBuildOutput, unavailableReason } from "./output.js";
import { buildRouteTree } from "./routes.js";
import { scanSources } from "./sources.js";

/** A throwaway project holding the given files, plus an `app` directory the tree can walk. */
function project(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-output-"));
  const appDirectory = join(root, "app");
  mkdirSync(appDirectory, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, appDirectory };
}

/** Backdates every source file, so a build written afterwards is newer than all of them. */
function backdate(root: string, files: readonly string[]): void {
  const past = new Date(Date.now() - 60_000);
  for (const file of files) utimesSync(join(root, file), past, past);
}

const PAGE = "export default function Page() { return null }\n";
const HANDLER = "export function GET() { return new Response('') }\n";

function scan(root: string) {
  return scanSources(root);
}

function tree(appDirectory: string) {
  return buildRouteTree({
    appDirectory,
    pageExtensions: DEFAULT_PAGE_EXTENSIONS,
    isFlagEnabled: () => true,
  });
}

/**
 * A project whose route files are the ones a snapshot's mapping names, so the join is exercised
 * against the shapes a real build produced rather than against a mapping invented here.
 */
function snapshotProject(version: SnapshotVersion, extra: Record<string, string> = {}) {
  const mapping = readSnapshot(version, "app-path-routes-manifest.json") as Record<string, string>;
  const files: Record<string, string> = { ...extra };
  for (const filePathRoute of Object.keys(mapping)) {
    const isHandler = filePathRoute.endsWith("/route");
    files[`app${filePathRoute}${isHandler ? ".ts" : ".tsx"}`] = isHandler ? HANDLER : PAGE;
  }
  const { root, appDirectory } = project(files);
  backdate(root, Object.keys(files));
  writeSnapshotBuild(root, version);
  return { root, appDirectory };
}

describe("recorded manifests", () => {
  for (const version of SNAPSHOT_VERSIONS) {
    it(`parses both snapshots of ${version}`, () => {
      const prerender = readSnapshot(version, "prerender-manifest.json") as { version: number };
      const mapping = readSnapshot(version, "app-path-routes-manifest.json");
      expect(prerender.version).toBe(4);
      expect(Object.keys(mapping as Record<string, string>).length).toBeGreaterThan(0);
    });
  }
});

/**
 * Where a project puts its build, which is the question every read below rests on and none of them
 * asked until now. A project setting `distDir` and a `.next` left over from before it did is the
 * failure worth guarding: the stale directory answers, and answering is worse than not.
 */
describe("the directory the build is read from", () => {
  const COMPLETE = {
    buildId: "abc",
    prerender: { version: 4, routes: {}, dynamicRoutes: {} },
    appPaths: {},
  };

  function readWith(root: string) {
    return readBuildOutput(root, scan(root), readNextConfig(root));
  }

  it("should read .next where the option is unset", () => {
    const { root } = project({ "next.config.ts": "export default {};" });
    writeBuild(root, COMPLETE);
    expect(readWith(root)).toMatchObject({ kind: "read" });
  });

  it("should read the configured directory instead", () => {
    const { root } = project({ "next.config.ts": "export default { distDir: 'build' };" });
    writeBuild(root, COMPLETE, "build");
    expect(readWith(root)).toMatchObject({ kind: "read" });
  });

  it("should not fall back to a .next left beside the configured directory", () => {
    const { root } = project({ "next.config.ts": "export default { distDir: 'build' };" });
    writeBuild(root, COMPLETE);
    expect(readWith(root)).toEqual({
      kind: "unavailable",
      reason: "no production build found at build",
    });
  });

  it("should yield unresolved where the configured value is not a literal", () => {
    const { root } = project({
      "next.config.ts": "export default { distDir: process.env.DIST ?? 'build' };",
    });
    writeBuild(root, COMPLETE, "build");
    const read = readWith(root);
    expect(read.kind).toBe("unavailable");
    if (read.kind !== "unavailable") return;
    expect(read.reason).toContain("distDir");
  });

  it("should name the configured directory in what it could not find", () => {
    const { root } = project({ "next.config.ts": "export default { distDir: 'build' };" });
    writeBuild(root, { buildId: "abc" }, "build");
    expect(readWith(root)).toEqual({
      kind: "unavailable",
      reason: "build holds no prerender-manifest.json",
    });
  });
});

describe("finding a build", () => {
  it("reports no build when there is no .next", () => {
    const { root } = project();
    const read = readBuildOutput(root, scan(root));
    expect(read).toEqual({ kind: "unavailable", reason: "no production build found at .next" });
  });

  /**
   * A build that compiled and then failed leaves the directory without a `BUILD_ID`. Saying no
   * build was found at a path the reader can see is a sentence they have to disprove first.
   */
  it("names the directory it found when .next holds no build id", () => {
    const { root } = project();
    writeBuild(root, { prerender: { version: 4, routes: {}, dynamicRoutes: {} }, appPaths: {} });
    expect(readBuildOutput(root, scan(root))).toEqual({
      kind: "unavailable",
      reason: ".next holds no BUILD_ID, so no build finished there",
    });
  });

  it("names the manifest a development server did not write", () => {
    const { root } = project();
    writeBuild(root, { buildId: "abc" });
    const read = readBuildOutput(root, scan(root));
    expect(read).toEqual({
      kind: "unavailable",
      reason: ".next holds no prerender-manifest.json",
    });
  });

  it("refuses a build without the route mapping, so absence cannot be read as dynamic", () => {
    const { root } = project();
    writeBuild(root, {
      buildId: "abc",
      prerender: { version: 4, routes: {}, dynamicRoutes: {} },
    });
    expect(readBuildOutput(root, scan(root))).toEqual({
      kind: "unavailable",
      reason: ".next holds no app-path-routes-manifest.json",
    });
  });

  it("refuses malformed JSON rather than failing the run", () => {
    const { root } = project();
    const next = writeBuild(root, { buildId: "abc" });
    writeFileSync(join(next, "prerender-manifest.json"), "{ not json");
    expect(readBuildOutput(root, scan(root))).toEqual({
      kind: "unavailable",
      reason: ".next/prerender-manifest.json is not valid JSON",
    });
  });

  it("carries the build id when the build reads", () => {
    const { root } = snapshotProject("16.3.0");
    const read = readBuildOutput(root, scan(root));
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.output.buildId).toBe("snapshot-16.3.0");
  });
});

describe("manifest shape", () => {
  function readWith(prerender: unknown) {
    const { root } = project();
    writeBuild(root, { buildId: "abc", prerender, appPaths: {} });
    backdate(root, []);
    return readBuildOutput(root, scan(root));
  }

  it("names the version it does not know", () => {
    const read = readWith({ version: 5, routes: {}, dynamicRoutes: {} });
    expect(read).toEqual({
      kind: "unavailable",
      reason: "prerender-manifest.json declares version 5",
    });
  });

  it("refuses a manifest with no routes", () => {
    expect(readWith({ version: 4, dynamicRoutes: {} })).toEqual({
      kind: "unavailable",
      reason: "prerender-manifest.json has no readable routes",
    });
  });

  it("reads an entry with no rendering mode as prerendered with an unknown mode", () => {
    // Next only writes `renderingMode` when PPR is turned on (`dist/build/index.js` sets it
    // `undefined` otherwise), so an entry missing it is still a route the build prerendered —
    // its presence in `routes` says that on its own — just with no mode recorded.
    const read = readWith({
      version: 4,
      routes: { "/a": { srcRoute: "/a" } },
      dynamicRoutes: {},
    });
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.output.unreadableEntries).toBe(0);
    expect(read.output.prerendered.size).toBe(1);
    expect(read.output.prerendered.get("/a")?.mode).toBeUndefined();
  });

  it("counts an unrecognised rendering mode rather than reading it as dynamic", () => {
    const read = readWith({
      version: 4,
      routes: { "/a": { renderingMode: "SOMETHING_NEW", srcRoute: "/a" } },
      dynamicRoutes: {},
    });
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.output.unreadableEntries).toBe(1);
  });

  it("reads the newer minor exactly as the older one, extra keys and all", () => {
    const older = snapshotProject("16.2.6");
    const newer = snapshotProject("16.3.0");
    const readOlder = readBuildOutput(older.root, scan(older.root));
    const readNewer = readBuildOutput(newer.root, scan(newer.root));
    expect(readOlder.kind).toBe("read");
    expect(readNewer.kind).toBe("read");
    if (readOlder.kind !== "read" || readNewer.kind !== "read") return;
    expect(readOlder.output.unreadableEntries).toBe(0);
    expect(readNewer.output.unreadableEntries).toBe(0);
    expect(readNewer.output.prerendered.size).toBe(readOlder.output.prerendered.size);
    expect(readNewer.output.dynamicRoutes.size).toBe(readOlder.output.dynamicRoutes.size);
  });
});

describe("staleness", () => {
  it("reports a build older than the source, with how many files are newer", () => {
    const { root } = snapshotProject("16.3.0");
    // Written after the build, which is what a working copy looks like most of the time.
    writeFileSync(join(root, "app", "later.ts"), "export const x = 1\n");
    const read = readBuildOutput(root, scan(root));
    expect(read.kind).toBe("stale");
    if (read.kind !== "stale") return;
    expect(read.newerFiles).toBe(1);
    expect(read.newest).toBe(join(root, "app", "later.ts"));
    // One edited file is the ordinary case, so it is the wording a reader meets first.
    expect(unavailableReason(read)).toBe("the build predates the source: 1 file is newer than it");
  });

  it("reads a build newer than every source file", () => {
    const { root } = snapshotProject("16.3.0");
    expect(readBuildOutput(root, scan(root)).kind).toBe("read");
  });

  it("stays fresh when only a test was written after the build", () => {
    const { root } = snapshotProject("16.3.0");
    // The build compiles neither, so neither can make what it wrote wrong.
    writeFileSync(join(root, "app", "later.test.ts"), "export const x = 1\n");
    mkdirSync(join(root, "e2e"), { recursive: true });
    writeFileSync(join(root, "e2e", "flow.spec.ts"), "export const y = 1\n");
    expect(readBuildOutput(root, scan(root)).kind).toBe("read");
  });

  it("still ages on a production file written beside a newer test", () => {
    const { root } = snapshotProject("16.3.0");
    writeFileSync(join(root, "app", "later.test.ts"), "export const x = 1\n");
    writeFileSync(join(root, "app", "later.ts"), "export const y = 1\n");
    const read = readBuildOutput(root, scan(root));
    expect(read.kind).toBe("stale");
    if (read.kind !== "stale") return;
    expect(read.newerFiles).toBe(1);
    expect(read.newest).toBe(join(root, "app", "later.ts"));
  });

  it("treats a source whose time cannot be read as newer than the build", () => {
    const { root } = snapshotProject("16.3.0");
    const sources = scan(root);
    const [first] = sources.files;
    expect(first).toBeDefined();
    if (first === undefined) return;
    rmSync(first.path);
    expect(readBuildOutput(root, sources).kind).toBe("stale");
  });
});

describe("joining routes to the build", () => {
  function joined(version: SnapshotVersion, extra: Record<string, string> = {}) {
    const { root, appDirectory } = snapshotProject(version, extra);
    const read = readBuildOutput(root, scan(root));
    if (read.kind !== "read") throw new Error(`expected a readable build, got ${read.kind}`);
    return {
      join: joinRoutes(tree(appDirectory), read.output, appDirectory),
      root,
    };
  }

  it("joins a route the build prerendered under its own URL", () => {
    const { join: result } = joined("16.2.6");
    const entry = result.routes.find((route) => route.filePathRoute === "/api/analytics/route");
    expect(entry?.url).toBe("/api/analytics");
    expect(entry?.recorded).toEqual({ kind: "prerendered", mode: "STATIC" });
  });

  it("joins a dynamic route through its pattern", () => {
    const { join: result } = joined("16.3.0");
    const entry = result.routes.find((route) => route.filePathRoute === "/[lang]/(home)/page");
    expect(entry?.url).toBe("/[lang]");
    expect(entry?.recorded).toEqual({ kind: "prerendered", mode: "PARTIALLY_STATIC" });
  });

  it("joins a route through a prerendered URL that names it as its source", () => {
    const { join: result } = joined("16.3.0");
    const entry = result.routes.find((route) => route.filePathRoute === "/[lang]/legal/page");
    expect(entry?.url).toBe("/[lang]/legal");
    expect(entry?.recorded).toEqual({ kind: "prerendered", mode: "PARTIALLY_STATIC" });
  });

  it("reads a route the build listed and did not prerender as not prerendered", () => {
    const { join: result } = joined("16.3.0");
    const entry = result.routes.find((route) => route.filePathRoute === "/api/auth/session/route");
    expect(entry?.recorded).toEqual({ kind: "not-prerendered" });
  });

  it("records a route of the tree the build does not mention", () => {
    const { join: result } = joined("16.3.0", { "app/nueva/page.tsx": PAGE });
    expect(result.unjoinedRoutes).toBe(1);
    expect(result.routes.some((route) => route.filePathRoute === "/nueva/page")).toBe(false);
  });

  it("leaves only the framework's own routes unclaimed on a real snapshot", () => {
    // The synthetic project is built from the mapping's own keys, so every entry has a file. The
    // two the tree still does not claim are `_not-found` and `_global-error`: their leading
    // underscore makes them private folders, which the walk skips — the framework supplies them.
    const { join: result } = joined("16.2.6");
    expect(result.unjoined).toEqual({ metadata: 0, framework: 2, unexplained: 0 });
  });

  it("keeps the build's URL when it disagrees with the derived one", () => {
    const { root, appDirectory } = project({ "app/blog/page.tsx": PAGE });
    backdate(root, ["app/blog/page.tsx"]);
    writeBuild(root, {
      buildId: "abc",
      prerender: { version: 4, routes: {}, dynamicRoutes: {} },
      appPaths: { "/blog/page": "/noticias" },
    });
    const read = readBuildOutput(root, scan(root));
    if (read.kind !== "read") throw new Error(`expected a readable build, got ${read.kind}`);
    const result = joinRoutes(tree(appDirectory), read.output, appDirectory);
    expect(result.disagreements).toEqual([
      { filePathRoute: "/blog/page", derived: "/blog", build: "/noticias" },
    ]);
    expect(result.routes[0]?.url).toBe("/noticias");
  });
});

describe("recorded route weights", () => {
  for (const version of SNAPSHOT_VERSIONS) {
    it(`reads the per-route figures of ${version}`, () => {
      const { root } = snapshotProject(version);
      const read = readBuildOutput(root, scan(root));
      expect(read.kind).toBe("read");
      if (read.kind !== "read") return;
      expect(read.output.weights.bytesByUrl.size).toBe(6);
      expect(read.output.weights.unreadableEntries).toBe(0);
      for (const bytes of read.output.weights.bytesByUrl.values()) {
        expect(bytes).toBeGreaterThan(0);
      }
    });
  }

  it("still resolves the build when the figures are absent", () => {
    const { root } = project();
    backdate(root, []);
    writeBuild(root, {
      buildId: "abc",
      prerender: { version: 4, routes: {}, dynamicRoutes: {} },
      appPaths: {},
    });
    const read = readBuildOutput(root, scan(root));
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.output.weights.bytesByUrl.size).toBe(0);
    expect(read.output.weights.reason).toContain("route-bundle-stats.json");
  });

  it("still resolves the build when the figures do not parse", () => {
    const { root } = project();
    backdate(root, []);
    const next = writeBuild(root, {
      buildId: "abc",
      prerender: { version: 4, routes: {}, dynamicRoutes: {} },
      appPaths: {},
    });
    mkdirSync(join(next, "diagnostics"), { recursive: true });
    writeFileSync(join(next, "diagnostics", "route-bundle-stats.json"), "{ not json");
    const read = readBuildOutput(root, scan(root));
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.output.weights.reason).toContain("not valid JSON");
  });

  it("skips and counts an entry missing a field rather than reading it as zero", () => {
    const { root } = project();
    backdate(root, []);
    writeBuild(root, {
      buildId: "abc",
      prerender: { version: 4, routes: {}, dynamicRoutes: {} },
      appPaths: {},
      bundleStats: [
        { route: "/a", firstLoadUncompressedJsBytes: 10 },
        { route: "/b" },
        { firstLoadUncompressedJsBytes: 20 },
      ],
    });
    const read = readBuildOutput(root, scan(root));
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.output.weights.bytesByUrl.get("/a")).toBe(10);
    expect(read.output.weights.bytesByUrl.has("/b")).toBe(false);
    expect(read.output.weights.unreadableEntries).toBe(2);
  });

  it("refuses a shape that is not the array this tool reads", () => {
    const { root } = project();
    backdate(root, []);
    writeBuild(root, {
      buildId: "abc",
      prerender: { version: 4, routes: {}, dynamicRoutes: {} },
      appPaths: {},
      bundleStats: { routes: [] },
    });
    const read = readBuildOutput(root, scan(root));
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.output.weights.reason).toContain("is not an array");
  });

  it("leaves the rendering-mode contrast unaffected when the figures are missing", () => {
    const { root } = snapshotProject("16.3.0");
    const read = readBuildOutput(root, scan(root));
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.output.prerendered.size).toBeGreaterThan(0);
  });
});

describe("an interception marker is notation, not disagreement", () => {
  /** A project whose build records one route, under whatever URL the test names. */
  function joinOf(filePathRoute: string, buildUrl: string, files: Record<string, string>) {
    const { root, appDirectory } = project(files);
    backdate(root, Object.keys(files));
    writeBuild(root, {
      buildId: "test",
      prerender: { version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [], preview: {} },
      appPaths: { [filePathRoute]: buildUrl },
    });
    const read = readBuildOutput(root, scan(root));
    if (read.kind !== "read") throw new Error(`expected a readable build, got ${read.kind}`);
    return joinRoutes(tree(appDirectory), read.output, appDirectory);
  }

  it.each([
    ["(.)", "app/@modal/(.)items/page.tsx", "/@modal/(.)items/page", "/(.)items"],
    ["(..)", "app/a/@modal/(..)items/page.tsx", "/a/@modal/(..)items/page", "/a/(..)items"],
    [
      "(..)(..)",
      "app/a/b/@modal/(..)(..)items/page.tsx",
      "/a/b/@modal/(..)(..)items/page",
      "/a/b/(..)(..)items",
    ],
    ["(...)", "app/a/@modal/(...)items/page.tsx", "/a/@modal/(...)items/page", "/a/(...)items"],
  ])("should agree across the %s marker", (_marker, file, filePathRoute, buildUrl) => {
    const join = joinOf(filePathRoute, buildUrl, { [file]: PAGE });
    expect(join.disagreements).toEqual([]);
  });

  it("should still report a difference the marker does not explain", () => {
    // Same marker, different route underneath. This is what the figure exists to catch.
    const join = joinOf("/@modal/(.)items/page", "/(.)elsewhere", {
      "app/@modal/(.)items/page.tsx": PAGE,
    });
    expect(join.disagreements).toHaveLength(1);
    expect(join.disagreements[0]?.build).toBe("/(.)elsewhere");
    expect(join.disagreements[0]?.derived).toBe("/items");
  });

  it("should report a difference on a route carrying no marker at all", () => {
    const join = joinOf("/items/page", "/somewhere-else", { "app/items/page.tsx": PAGE });
    expect(join.disagreements).toHaveLength(1);
  });
});

describe("an unclaimed build entry is classified by what it is", () => {
  /** A build whose mapping holds exactly the given keys, and a project with one page. */
  function unjoinedFor(keys: readonly string[]) {
    const files = { "app/page.tsx": PAGE };
    const { root, appDirectory } = project(files);
    backdate(root, Object.keys(files));
    const appPaths: Record<string, string> = { "/page": "/" };
    for (const key of keys) appPaths[key] = key.replace(/\/(route|page)$/, "");
    writeBuild(root, {
      buildId: "test",
      prerender: { version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [], preview: {} },
      appPaths,
    });
    const read = readBuildOutput(root, scan(root));
    if (read.kind !== "read") throw new Error(`expected a readable build, got ${read.kind}`);
    return joinRoutes(tree(appDirectory), read.output, appDirectory).unjoined;
  }

  it.each([
    "/sitemap.xml/route",
    "/robots.txt/route",
    "/manifest.webmanifest/route",
    "/icon/route",
    "/icon.svg/route",
    "/apple-icon/route",
    "/opengraph-image/route",
    "/twitter-image/route",
    "/favicon.ico/route",
    "/[lang]/opengraph-image/route",
  ])("should count %s as metadata rather than as a gap", (key) => {
    const unjoined = unjoinedFor([key]);
    expect(unjoined.metadata).toBe(1);
    expect(unjoined.unexplained).toBe(0);
  });

  it.each(["/_not-found/page", "/_global-error/page"])(
    "should count %s as a route the framework generates",
    (key) => {
      const unjoined = unjoinedFor([key]);
      expect(unjoined.framework).toBe(1);
      expect(unjoined.unexplained).toBe(0);
    },
  );

  it("should still count an entry that is neither", () => {
    const unjoined = unjoinedFor(["/whatever/route"]);
    expect(unjoined.unexplained).toBe(1);
    expect(unjoined.metadata).toBe(0);
    expect(unjoined.framework).toBe(0);
  });

  it("should have the parts sum to every entry no route claimed", () => {
    const keys = ["/sitemap.xml/route", "/_not-found/page", "/whatever/route"];
    const { metadata, framework, unexplained } = unjoinedFor(keys);
    expect(metadata + framework + unexplained).toBe(keys.length);
  });
});
