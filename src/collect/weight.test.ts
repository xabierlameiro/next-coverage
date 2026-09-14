import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_EXTENSIONS } from "../types.js";
import { buildGraph } from "./graph.js";
import { buildRouteTree } from "./routes.js";
import { scanSources } from "./sources.js";
import { buildWeights, contrastWeights, type WeightReport } from "./weight.js";

const CLIENT = "'use client'\n";
const PAGE = "export default function Page() { return null }\n";

function weightsOf(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-weight-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const appDirectory = join(root, "app");
  mkdirSync(appDirectory, { recursive: true });
  const sources = scanSources(root);
  const tree = buildRouteTree({
    appDirectory,
    pageExtensions: DEFAULT_PAGE_EXTENSIONS,
    isFlagEnabled: () => true,
  });
  return {
    report: buildWeights(tree, buildGraph(sources), sources),
    at: (name: string) => join(root, name),
  };
}

function rowFor(report: ReturnType<typeof weightsOf>["report"], url: string) {
  return report.routes.find((route) => route.url === url);
}

describe("per-route attribution", () => {
  it("attributes a client module the page imports", () => {
    const { report, at } = weightsOf({
      "app/panel/page.tsx": "import { w } from '../../widget'\nexport default () => w\n",
      "widget.tsx": `${CLIENT}export const w = 1\n`,
    });
    expect([...(rowFor(report, "/panel")?.modules ?? [])]).toEqual([at("widget.tsx")]);
  });

  it("attributes a module reached only through an ancestor layout", () => {
    const { report, at } = weightsOf({
      "app/layout.tsx": "import { n } from '../nav'\nexport default () => n\n",
      "app/panel/page.tsx": PAGE,
      "nav.tsx": `${CLIENT}export const n = 1\n`,
    });
    expect([...(rowFor(report, "/panel")?.modules ?? [])]).toEqual([at("nav.tsx")]);
  });

  it("attributes one module to both routes that reach it", () => {
    const { report, at } = weightsOf({
      "app/one/page.tsx": "import { w } from '../../widget'\nexport default () => w\n",
      "app/two/page.tsx": "import { w } from '../../widget'\nexport default () => w\n",
      "widget.tsx": `${CLIENT}export const w = 1\n`,
    });
    expect([...(rowFor(report, "/one")?.modules ?? [])]).toEqual([at("widget.tsx")]);
    expect([...(rowFor(report, "/two")?.modules ?? [])]).toEqual([at("widget.tsx")]);
  });

  it("does not attribute a module outside the client closure", () => {
    const { report } = weightsOf({
      "app/panel/page.tsx": "import { q } from '../../query'\nexport default () => q\n",
      "query.ts": "export const q = 1\n",
    });
    expect(rowFor(report, "/panel")?.modules.size).toBe(0);
  });

  it("does not attribute a co-located test, which the build never bundles", () => {
    const { report } = weightsOf({
      "app/panel/page.tsx": "import { w } from '../../widget'\nexport default () => w\n",
      "app/panel/page.test.tsx":
        "import { w } from '../../widget'\nimport { it } from 'vitest'\nit('x', () => w)\n",
      "widget.tsx": `${CLIENT}export const w = 1\n`,
    });
    expect(rowFor(report, "/panel")?.modules.size).toBe(1);
  });

  it("reports a route with no client code rather than omitting it", () => {
    const { report } = weightsOf({ "app/panel/page.tsx": PAGE });
    expect(rowFor(report, "/panel")).toBeDefined();
    expect(rowFor(report, "/panel")?.modules.size).toBe(0);
  });

  it("lists every layout a nested route inherits", () => {
    const { report, at } = weightsOf({
      "app/layout.tsx": PAGE,
      "app/a/layout.tsx": PAGE,
      "app/a/b/layout.tsx": PAGE,
      "app/a/b/page.tsx": PAGE,
    });
    expect([...(rowFor(report, "/a/b")?.entries ?? [])].sort()).toEqual(
      [
        at("app/a/b/page.tsx"),
        at("app/layout.tsx"),
        at("app/a/layout.tsx"),
        at("app/a/b/layout.tsx"),
      ].sort(),
    );
  });

  it("orders the routes by client modules, heaviest first", () => {
    const { report } = weightsOf({
      "app/heavy/page.tsx":
        "import { a } from '../../a'\nimport { b } from '../../b'\nexport default () => [a, b]\n",
      "app/light/page.tsx": "import { a } from '../../a'\nexport default () => a\n",
      "a.tsx": `${CLIENT}export const a = 1\n`,
      "b.tsx": `${CLIENT}export const b = 2\n`,
    });
    expect(report.routes.map((route) => route.url)).toEqual(["/heavy", "/light"]);
  });
});

describe("routes sharing a URL", () => {
  it("unions the modules of two parallel slots", () => {
    const { report, at } = weightsOf({
      "app/dash/layout.tsx": PAGE,
      "app/dash/@one/page.tsx": "import { a } from '../../../a'\nexport default () => a\n",
      "app/dash/@two/page.tsx": "import { b } from '../../../b'\nexport default () => b\n",
      "a.tsx": `${CLIENT}export const a = 1\n`,
      "b.tsx": `${CLIENT}export const b = 2\n`,
    });
    const row = rowFor(report, "/dash");
    expect([...(row?.modules ?? [])].sort()).toEqual([at("a.tsx"), at("b.tsx")].sort());
    expect(report.routes.filter((route) => route.url === "/dash")).toHaveLength(1);
  });

  it("counts a module both slots reach only once", () => {
    const { report, at } = weightsOf({
      "app/dash/layout.tsx": PAGE,
      "app/dash/@one/page.tsx": "import { a } from '../../../a'\nexport default () => a\n",
      "app/dash/@two/page.tsx": "import { a } from '../../../a'\nexport default () => a\n",
      "a.tsx": `${CLIENT}export const a = 1\n`,
    });
    expect([...(rowFor(report, "/dash")?.modules ?? [])]).toEqual([at("a.tsx")]);
  });
});

/** A weight report built by hand, so the contrast is tested on the numbers and nothing else. */
function reportOf(rows: readonly (readonly [url: string, modules: number])[]): WeightReport {
  return {
    routes: rows.map(([url, modules]) => ({
      url,
      modules: new Set(Array.from({ length: modules }, (_, i) => `${url}#${i}`)),
      filePathRoutes: [],
      entries: [],
    })),
    urlSource: "build",
  };
}

describe("contrasting the two orderings", () => {
  it("reports complete agreement and names no route when the orders match", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 3],
        ["/b", 2],
        ["/c", 1],
      ]),
      new Map([
        ["/a", 300],
        ["/b", 200],
        ["/c", 100],
      ]),
    );
    expect(contrast.agreement).toBe(1);
    expect(contrast.furthest).toHaveLength(0);
    expect(contrast.compared).toBe(3);
  });

  it("reports complete disagreement when the orders are reversed", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 3],
        ["/b", 2],
        ["/c", 1],
      ]),
      new Map([
        ["/a", 100],
        ["/b", 200],
        ["/c", 300],
      ]),
    );
    expect(contrast.agreement).toBe(-1);
  });

  it("gives no figure when every pair is tied on one side", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 2],
        ["/b", 2],
        ["/c", 2],
      ]),
      new Map([
        ["/a", 300],
        ["/b", 200],
        ["/c", 100],
      ]),
    );
    expect(contrast.agreement).toBeUndefined();
    expect(contrast.compared).toBe(3);
  });

  it("names the route the two orderings place furthest apart, with both positions", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/heavy", 10],
        ["/mid", 5],
        ["/odd", 4],
      ]),
      new Map([
        ["/heavy", 300],
        ["/mid", 100],
        ["/odd", 200],
      ]),
    );
    const [first] = contrast.furthest;
    expect(first?.url).toBe("/mid");
    expect(first?.byModules).toBe(2);
    expect(first?.byBytes).toBe(3);
    expect(first?.gap).toBe(1);
  });

  it("counts the routes left out for want of a recorded figure", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 3],
        ["/b", 2],
        ["/api/thing", 0],
      ]),
      new Map([
        ["/a", 300],
        ["/b", 200],
      ]),
    );
    expect(contrast.compared).toBe(2);
    expect(contrast.withoutFigure).toBe(1);
    expect(contrast.reason).toBeUndefined();
  });

  it("gives no agreement when fewer than two routes are comparable", () => {
    const contrast = contrastWeights(reportOf([["/a", 3]]), new Map([["/a", 300]]));
    expect(contrast.agreement).toBeUndefined();
    expect(contrast.compared).toBe(1);
    expect(contrast.reason).toContain("fewer than two routes");
  });

  it("draws nothing and keeps the reason when the build could not answer", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 3],
        ["/b", 2],
      ]),
      new Map(),
      "the build predates the source: 4 files are newer than it",
    );
    expect(contrast.agreement).toBeUndefined();
    expect(contrast.furthest).toHaveLength(0);
    expect(contrast.reason).toContain("predates the source");
  });

  it("shares a rank between tied routes rather than ordering them arbitrarily", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 5],
        ["/b", 5],
        ["/c", 1],
      ]),
      new Map([
        ["/a", 300],
        ["/b", 300],
        ["/c", 100],
      ]),
    );
    expect(contrast.furthest).toHaveLength(0);
  });
});

/**
 * The agreement counts a pair the same whether the two routes differ by a kilobyte or by eight
 * hundred, so on its own it cannot distinguish an ordering wrong about routes that differ from one
 * wrong about routes that do not. Across the corpus it is the second that happens.
 */
describe("what a disagreement weighs", () => {
  it("separates the pairs it places differently from the ones it agrees on", () => {
    // /a and /b are close in bytes and inverted; /c is far from both and placed alike.
    const contrast = contrastWeights(
      reportOf([
        ["/a", 3],
        ["/b", 2],
        ["/c", 1],
      ]),
      new Map([
        ["/a", 1_000],
        ["/b", 1_010],
        ["/c", 100],
      ]),
    );
    expect(contrast.separation?.whenDiffering).toBe(10);
    // Both agreeing pairs are /c against one of the others: 900 and 910, median 910.
    expect(contrast.separation?.whenAgreeing).toBe(910);
  });

  it("gives no separation when nothing is placed differently", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 2],
        ["/b", 1],
      ]),
      new Map([
        ["/a", 200],
        ["/b", 100],
      ]),
    );
    expect(contrast.agreement).toBe(1);
    // A median over no pairs is not zero, and publishing zero would read as "no difference at all".
    expect(contrast.separation).toBeUndefined();
  });

  it("gives no separation when everything is placed differently", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 2],
        ["/b", 1],
      ]),
      new Map([
        ["/a", 100],
        ["/b", 200],
      ]),
    );
    expect(contrast.agreement).toBe(-1);
    expect(contrast.separation).toBeUndefined();
  });

  /** The population the agreement is a proportion of, which is not the count of routes. */
  it("counts the pairs both orderings place, not the routes", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 3],
        ["/b", 2],
        ["/c", 2],
      ]),
      new Map([
        ["/a", 300],
        ["/b", 200],
        ["/c", 100],
      ]),
    );
    // Three routes make three pairs; /b and /c tie on modules, so two are placed.
    expect(contrast.compared).toBe(3);
    expect(contrast.orderedPairs).toBe(2);
  });

  it("reports no ordered pairs when every pair is tied on one side", () => {
    const contrast = contrastWeights(
      reportOf([
        ["/a", 2],
        ["/b", 2],
      ]),
      new Map([
        ["/a", 200],
        ["/b", 100],
      ]),
    );
    expect(contrast.agreement).toBeUndefined();
    expect(contrast.orderedPairs).toBe(0);
  });
});
