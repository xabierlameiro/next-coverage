import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_EXTENSIONS } from "../types.js";
import { FLAG_GATED_CONVENTIONS } from "./conventions.js";
import { buildRouteTree, pageUrls, type RouteTree, routableUrls } from "./routes.js";

/** Builds a throwaway app directory from a map of relative path to file contents. */
function syntheticApp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-app-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function treeOf(appDirectory: string, flagsOn: readonly string[] = []): RouteTree {
  return buildRouteTree({
    appDirectory,
    pageExtensions: DEFAULT_PAGE_EXTENSIONS,
    isFlagEnabled: (flag) => flagsOn.includes(flag),
  });
}

const PAGE = "export default function P() { return null }\n";

describe("url segments", () => {
  it("should not let a route group contribute a segment", () => {
    const app = syntheticApp({ "(marketing)/about/page.tsx": PAGE });
    expect(routableUrls(treeOf(app))).toEqual(["/about"]);
  });

  it("should not let a parallel slot contribute a segment", () => {
    const app = syntheticApp({
      "dashboard/@modal/default.tsx": PAGE,
      "dashboard/page.tsx": PAGE,
    });
    expect(routableUrls(treeOf(app))).toEqual(["/dashboard"]);
  });

  it("should exclude private folders and never scan inside them", () => {
    const app = syntheticApp({
      "_components/page.tsx": PAGE,
      "about/page.tsx": PAGE,
    });
    const tree = treeOf(app);
    expect(routableUrls(tree)).toEqual(["/about"]);
    expect(tree.nodes.some((n) => n.dirName === "_components")).toBe(false);
  });

  it("should classify the three kinds of dynamic segment", () => {
    const app = syntheticApp({
      "a/[slug]/page.tsx": PAGE,
      "b/[...slug]/page.tsx": PAGE,
      "c/[[...slug]]/page.tsx": PAGE,
    });
    const byName = new Map(treeOf(app).nodes.map((n) => [n.dirName, n.kind]));
    expect(byName.get("[slug]")).toBe("dynamic");
    expect(byName.get("[...slug]")).toBe("catch-all");
    expect(byName.get("[[...slug]]")).toBe("optional-catch-all");
  });

  it("should count segments and not directories when interception crosses a group", () => {
    const app = syntheticApp({
      "feed/page.tsx": PAGE,
      "feed/(overlay)/(..)photo/[id]/page.tsx": PAGE,
    });
    const node = treeOf(app).nodes.find((n) => n.kind === "intercepting");
    expect(node).toBeDefined();
    // The group above it is a directory, not a segment, so the URL stays under /feed.
    expect(node?.urlPath).toBe("/feed/photo");
    expect(node?.interceptionDepth).toBe(1);
  });

  it("should model children as an implicit slot with no directory", () => {
    const app = syntheticApp({ "page.tsx": PAGE });
    expect(treeOf(app).implicitChildrenSlot).toBe(true);
  });
});

describe("structural issues", () => {
  it("should report a route and page conflict in one segment", () => {
    const app = syntheticApp({
      "api/page.tsx": PAGE,
      "api/route.ts": "export function GET() {}\n",
    });
    const issues = treeOf(app).issues.filter((i) => i.kind === "route-page-conflict");
    expect(issues).toHaveLength(1);
  });

  it("should report a slot with no default", () => {
    const app = syntheticApp({ "dashboard/@modal/page.tsx": PAGE });
    const issues = treeOf(app).issues.filter((i) => i.kind === "slot-without-default");
    expect(issues).toHaveLength(1);
  });

  it("should report two route groups resolving to the same url", () => {
    const app = syntheticApp({
      "(a)/about/page.tsx": PAGE,
      "(b)/about/page.tsx": PAGE,
    });
    const issues = treeOf(app).issues.filter((i) => i.kind === "route-group-collision");
    expect(issues).toHaveLength(1);
    // The colliding URL, not the URL the groups themselves sit on: they are in different
    // parents, so a sibling comparison would have named `/` for a clash at `/about`.
    expect(issues[0]).toMatchObject({ urlPath: "/about" });
  });

  it("should not call it a collision when the groups only organise a url", () => {
    // Two groups always share their parent's URL — that is what a group is. It collides only
    // when more than one of them serves a page there.
    const app = syntheticApp({
      "(a)/about/page.tsx": PAGE,
      "(b)/contact/page.tsx": PAGE,
      "(b)/layout.tsx": PAGE,
    });
    expect(treeOf(app).issues.filter((i) => i.kind === "route-group-collision")).toEqual([]);
  });

  it("should see a collision through a nested group", () => {
    const app = syntheticApp({
      "(shell)/(marketing)/about/page.tsx": PAGE,
      "(other)/about/page.tsx": PAGE,
    });
    expect(treeOf(app).issues.filter((i) => i.kind === "route-group-collision")).toHaveLength(1);
  });

  it("should not call a parallel slot a collision", () => {
    // A slot serving the same URL as the page beside it is the feature, not a clash.
    const app = syntheticApp({
      "page.tsx": PAGE,
      "@modal/page.tsx": PAGE,
      "@modal/default.tsx": PAGE,
    });
    expect(treeOf(app).issues.filter((i) => i.kind === "route-group-collision")).toEqual([]);
  });

  it("should report a near-miss instead of accepting the wrong casing", () => {
    const app = syntheticApp({ "about/Page.tsx": PAGE });
    const tree = treeOf(app);
    expect(tree.issues.filter((i) => i.kind === "casing-near-miss")).toHaveLength(1);
    expect(routableUrls(tree)).toEqual([]);
  });

  it("should not follow a symlink pointing outside the app directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "next-coverage-outside-"));
    writeFileSync(join(outside, "page.tsx"), PAGE);
    const app = syntheticApp({ "keep/page.tsx": PAGE });
    symlinkSync(outside, join(app, "escape"), "dir");
    const tree = treeOf(app);
    expect(tree.issues.filter((i) => i.kind === "skipped-symlink")).toHaveLength(1);
    expect(routableUrls(tree)).toEqual(["/keep"]);
  });

  it("should follow a symlink that stays inside the app directory", () => {
    const app = syntheticApp({ "real/page.tsx": PAGE });
    symlinkSync(join(app, "real"), join(app, "aliased"), "dir");
    const tree = treeOf(app);
    expect(tree.issues.filter((i) => i.kind === "skipped-symlink")).toEqual([]);
    expect(routableUrls(tree)).toEqual(["/aliased", "/real"]);
  });

  it("should produce an empty tree for an app directory with no routes", () => {
    const app = syntheticApp({});
    const tree = treeOf(app);
    expect(routableUrls(tree)).toEqual([]);
    expect(tree.nodes).toHaveLength(1);
  });
});

describe("convention matching", () => {
  it("should recognise a page using a custom page extension", () => {
    const app = syntheticApp({ "docs/page.mdx": "# hi\n" });
    const tree = buildRouteTree({
      appDirectory: app,
      pageExtensions: ["tsx", "mdx"],
      isFlagEnabled: () => false,
    });
    expect(routableUrls(tree)).toEqual(["/docs"]);
  });

  it("should skip a flag-gated convention when its flag is off", () => {
    const app = syntheticApp({ "forbidden.tsx": PAGE, "page.tsx": PAGE });
    const found = treeOf(app).root.conventions.find((c) => c.name === "forbidden");
    expect(found?.skippedForFlag).toBe("experimental.authInterrupts");
  });

  it("should accept a flag-gated convention when its flag is on", () => {
    const app = syntheticApp({ "forbidden.tsx": PAGE, "page.tsx": PAGE });
    const tree = treeOf(app, ["experimental.authInterrupts"]);
    const found = tree.root.conventions.find((c) => c.name === "forbidden");
    expect(found?.skippedForFlag).toBeUndefined();
  });

  it("should record non-reserved files as co-located, not as routes", () => {
    const app = syntheticApp({ "about/page.tsx": PAGE, "about/card.tsx": PAGE });
    const node = treeOf(app).nodes.find((n) => n.urlPath === "/about");
    expect(node?.colocated).toContain("card.tsx");
  });
});

const ROUTE = "export function GET() { return new Response() }\n";

describe("the urls a page renders", () => {
  it("should leave route handlers to the reading that counts what answers at all", () => {
    const app = syntheticApp({ "about/page.tsx": PAGE, "api/health/route.ts": ROUTE });
    const tree = treeOf(app);
    expect(routableUrls(tree)).toEqual(["/about", "/api/health"]);
    expect(pageUrls(tree)).toEqual(["/about"]);
  });

  it("should count a page inside a slot as the page its parent already serves", () => {
    const app = syntheticApp({
      "panel/@lateral/page.tsx": PAGE,
      "panel/page.tsx": PAGE,
    });
    // `routableUrls` arrives at the same answer by the slot's URL path matching its parent's. This
    // reading skips the slot outright, so the two agree here for different reasons.
    expect(pageUrls(treeOf(app))).toEqual(["/panel"]);
  });

  it("should have no flag-gated convention deciding either reading", () => {
    // Both readings filter on `skippedForFlag`, and today that guard reaches nothing: the three
    // gated conventions serve no URL either one counts. A release gating `page` or `route` would
    // put the guard in charge of a figure nobody has looked at, so it fails here first.
    const gated: readonly string[] = Object.keys(FLAG_GATED_CONVENTIONS);
    expect(gated).not.toContain("page");
    expect(gated).not.toContain("route");
  });
});
