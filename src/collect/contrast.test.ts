import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeBuild } from "../../test-support/manifests.js";
import { DEFAULT_PAGE_EXTENSIONS } from "../types.js";
import { buildConstraints } from "./constraints.js";
import { buildContrast } from "./contrast.js";
import { buildGraph } from "./graph.js";
import { readBuildOutput } from "./output.js";
import { buildRouteTree } from "./routes.js";
import { scanSources } from "./sources.js";

const STATIC_SLOT = "export default function Slot() { return null }\n";
const DYNAMIC_SLOT =
  "import { headers } from 'next/headers';\n" +
  "export default async function Slot() { return (await headers()).get('x') }\n";
const LAYOUT = "export default function Layout() { return null }\n";

/** The one segment whose slots disagree, which is the claim this channel contrasts. */
const SLOTS = {
  "app/dash/layout.tsx": LAYOUT,
  "app/dash/@aside/page.tsx": STATIC_SLOT,
  "app/dash/@main/page.tsx": DYNAMIC_SLOT,
};

type BuildFiles = Parameters<typeof writeBuild>[1];

function contrastOf(
  build: BuildFiles,
  files: Record<string, string> = SLOTS,
  segmentConfigRemoved = false,
) {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-contrast-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
    const past = new Date(Date.now() - 60_000);
    utimesSync(full, past, past);
  }
  const appDirectory = join(root, "app");
  mkdirSync(appDirectory, { recursive: true });
  if (Object.keys(build).length > 0) writeBuild(root, build);

  const sources = scanSources(root);
  const tree = buildRouteTree({
    appDirectory,
    pageExtensions: DEFAULT_PAGE_EXTENSIONS,
    isFlagEnabled: () => true,
  });
  // The contrast takes the whole channel; this file only exercises the slot-mode part of it.
  const constraints = {
    ...buildConstraints(sources, tree, buildGraph(sources)),
    withoutEntry: 0,
    unread: [],
  };
  const read = readBuildOutput(root, sources);
  return {
    constraints,
    report: buildContrast(read, tree, appDirectory, constraints, sources, segmentConfigRemoved),
  };
}

function manifest(routes: Record<string, unknown>): BuildFiles {
  return {
    buildId: "test-build",
    prerender: { version: 4, routes, dynamicRoutes: {} },
    appPaths: { "/dash/@aside/page": "/dash", "/dash/@main/page": "/dash" },
  };
}

describe("a claim the build can answer", () => {
  it("reports what the build produced when it prerendered a slot said to lose it", () => {
    const { constraints, report } = contrastOf(
      manifest({ "/dash": { renderingMode: "STATIC", srcRoute: "/dash" } }),
    );
    // The claim being contrasted has to exist in the first place.
    expect(constraints.findings).toHaveLength(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      claim: "slot-prerendering",
      route: "/dash",
      recorded: "prerendered in full",
    });
    expect(report.findings[0]?.expected).toContain("@main");
    expect(report.buildId).toBe("test-build");
  });

  it("counts a claim the build bore out, and reports nothing about it", () => {
    const { report } = contrastOf(manifest({}));
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toBe(1);
    expect(report.unanswered).toEqual({ absentRoute: 0, undecidedMode: 0 });
  });

  it("leaves partial prerendering unanswered rather than reading a verdict into it", () => {
    const { report } = contrastOf(
      manifest({ "/dash": { renderingMode: "PARTIALLY_STATIC", srcRoute: "/dash" } }),
    );
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toBe(0);
    expect(report.unanswered).toEqual({ absentRoute: 0, undecidedMode: 1 });
  });

  // A build without PPR turned on records no mode at all, same as partial prerendering: neither
  // tells this claim whether the slot lost the whole route or just its own shell.
  it("leaves an unrecorded mode unanswered the same way as partial prerendering", () => {
    const { report } = contrastOf(manifest({ "/dash": { srcRoute: "/dash" } }));
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toBe(0);
    expect(report.unanswered).toEqual({ absentRoute: 0, undecidedMode: 1 });
  });

  it("counts a claim about a route the build does not mention as unanswered", () => {
    const { report } = contrastOf({
      buildId: "test-build",
      prerender: { version: 4, routes: {}, dynamicRoutes: {} },
      appPaths: {},
    });
    expect(report.checked).toBe(0);
    expect(report.unanswered).toEqual({ absentRoute: 1, undecidedMode: 0 });
  });
});

/**
 * A route the build prerendered is one where "this renders on demand instead of being prerendered"
 * has been answered, so the suggestion is withdrawn rather than printed. The count is what tells a
 * reader the absence has a cause.
 */
describe("routes a measurement answered for", () => {
  const PAGE = "export default function P() { return null }\n";
  const GENERATES =
    "export async function generateStaticParams() { return [] }\n" +
    "export default function P() { return null }\n";

  function dynamicBuild(dynamicRoutes: Record<string, unknown>, appPaths: Record<string, string>) {
    return {
      buildId: "test-build",
      prerender: { version: 4, routes: {}, dynamicRoutes },
      appPaths,
    };
  }

  it("counts a dynamic route the build prerendered", () => {
    const { report } = contrastOf(
      dynamicBuild(
        { "/[slug]": { renderingMode: "PARTIALLY_STATIC", fallback: "/[slug]" } },
        { "/[slug]/page": "/[slug]" },
      ),
      { "app/[slug]/page.tsx": PAGE },
    );
    expect(report.withdrawn).toBe(1);
  });

  it("counts only the routes the build prerendered", () => {
    const { report } = contrastOf(
      dynamicBuild(
        { "/[slug]": { renderingMode: "STATIC", fallback: "/[slug]" } },
        { "/[slug]/page": "/[slug]", "/[id]/page": "/[id]" },
      ),
      { "app/[slug]/page.tsx": PAGE, "app/[id]/page.tsx": PAGE },
    );
    expect(report.withdrawn).toBe(1);
  });

  it("counts nothing for a page that generates its params", () => {
    const { report } = contrastOf(
      dynamicBuild(
        { "/[slug]": { renderingMode: "STATIC", fallback: "/[slug]" } },
        { "/[slug]/page": "/[slug]" },
      ),
      { "app/[slug]/page.tsx": GENERATES },
    );
    expect(report.withdrawn).toBe(0);
  });

  it("counts nothing when there is no build to answer", () => {
    const { report } = contrastOf({}, { "app/[slug]/page.tsx": PAGE });
    expect(report.withdrawn).toBe(0);
  });
});

describe("a build that cannot answer", () => {
  it("draws nothing and gives the reason when there is no build", () => {
    const { report } = contrastOf({});
    expect(report.findings).toHaveLength(0);
    expect(report.buildId).toBeUndefined();
    expect(report.reason).toBe("no production build found at .next");
  });

  it("draws nothing from a build older than the source", () => {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-contrast-stale-"));
    const appDirectory = join(root, "app");
    mkdirSync(appDirectory, { recursive: true });
    writeBuild(root, manifest({}));
    // Written after the build, so every claim about it is a claim about older code.
    for (const [relativePath, contents] of Object.entries(SLOTS)) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    const sources = scanSources(root);
    const tree = buildRouteTree({
      appDirectory,
      pageExtensions: DEFAULT_PAGE_EXTENSIONS,
      isFlagEnabled: () => true,
    });
    const constraints = {
      ...buildConstraints(sources, tree, buildGraph(sources)),
      withoutEntry: 0,
      unread: [],
    };
    const report = buildContrast(
      readBuildOutput(root, sources),
      tree,
      appDirectory,
      constraints,
      sources,
      false,
    );
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toBe(0);
    expect(report.reason).toContain("the build predates the source");
  });
});

const FORCED = (value: string) =>
  `export const dynamic = '${value}';\nexport default function Page() { return null }\n`;

/** One route declaring the option, with the mapping the build would key it by. */
function forced(value: string, routes: Record<string, unknown>, segmentConfigRemoved = false) {
  return contrastOf(
    {
      buildId: "test-build",
      prerender: { version: 4, routes, dynamicRoutes: {} },
      appPaths: { "/informes/page": "/informes" },
    },
    { "app/informes/page.tsx": FORCED(value) },
    segmentConfigRemoved,
  );
}

const PRERENDERED = { "/informes": { renderingMode: "STATIC", srcRoute: "/informes" } };

describe("a route declaring what the build should do with it", () => {
  it("counts force-static as checked when the build prerendered it", () => {
    const { report } = forced("force-static", PRERENDERED);
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toBe(1);
  });

  it("reports that the build did not prerender a route declared force-static", () => {
    const { report } = forced("force-static", {});
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      claim: "force-static",
      route: "/informes",
      recorded: "among the routes the build did not prerender",
    });
    expect(report.findings[0]?.expected).toContain("force-static");
  });

  it("names the mode the build recorded for a route declared force-dynamic", () => {
    const { report } = forced("force-dynamic", PRERENDERED);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      claim: "force-dynamic",
      recorded: "prerendered as STATIC",
    });
  });

  it("counts force-dynamic as checked when the build left it out", () => {
    const { report } = forced("force-dynamic", {});
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toBe(1);
  });

  // Without PPR turned on, Next.js writes a route entry with no `renderingMode` at all — the
  // manifest still lists it in `routes`, which is what says the build prerendered it. Reading the
  // entry as unreadable produced a false disagreement here: the build did what the claim expected.
  it("counts force-static as agreed for a build without PPR, which records no mode", () => {
    const { report } = forced("force-static", { "/informes": { srcRoute: "/informes" } });
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toBe(1);
  });

  it("reports a route declared force-dynamic without printing an unrecorded mode as undefined", () => {
    const { report } = forced("force-dynamic", { "/informes": { srcRoute: "/informes" } });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.recorded).toBe("prerendered");
    expect(report.findings[0]?.recorded).not.toContain("undefined");
  });

  it("says nothing about a route whose option is not a literal", () => {
    const { report } = contrastOf(
      {
        buildId: "test-build",
        prerender: { version: 4, routes: {}, dynamicRoutes: {} },
        appPaths: { "/informes/page": "/informes" },
      },
      {
        "app/informes/page.tsx":
          "const mode = process.env.MODE;\nexport const dynamic = mode;\n" +
          "export default function Page() { return null }\n",
      },
    );
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toBe(0);
  });
});

describe("a configuration that removed the segment config the claim reads", () => {
  it("should derive no mode claim, because the framework refuses to compile the declaration", () => {
    // Not withdrawn after the fact: never made. The build the claim would be contrasted against is
    // one this project cannot produce while both are written.
    const { report } = forced("force-static", PRERENDERED, true);
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toBe(0);
  });

  it("should not count the claim it did not make among the unanswered", () => {
    // An unanswered claim is one a build could have settled. This one could not exist.
    const { report } = forced("force-dynamic", {}, true);
    expect(report.unanswered.absentRoute).toBe(0);
    expect(report.unanswered.undecidedMode).toBe(0);
  });

  it("should still derive the slot claim, which reads the shape of the routes", () => {
    const build = manifest({ "/dash": { renderingMode: "STATIC", srcRoute: "/dash" } });
    const withFlag = contrastOf(build, SLOTS, true);
    const withoutFlag = contrastOf(build, SLOTS, false);
    // Asserted above zero first: two equal counts of nothing would pass this while proving it.
    expect(withoutFlag.report.checked).toBeGreaterThan(0);
    expect(withFlag.report.checked).toBe(withoutFlag.report.checked);
    expect(withFlag.report.findings).toHaveLength(withoutFlag.report.findings.length);
  });
});
