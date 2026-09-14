import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileIn, fixtureContext } from "../../test-support/corpus.js";
import { buildGraph } from "../collect/graph.js";
import { EMPTY_JOIN } from "../collect/output.js";
import type { Bundler, ProjectContext } from "../collect/project.js";
import { buildRouteTree } from "../collect/routes.js";
import { scanSources } from "../collect/sources.js";
import { DEFAULT_PAGE_EXTENSIONS, resolved, unresolved } from "../types.js";
import { METADATA_PREDICATES } from "./metadata.js";
import type { PredicateContext } from "./types.js";

const APP_ICONS = "file-conventions/metadata/app-icons";

function project(files: Record<string, string>): PredicateContext {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-meta-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const appDirectory = { path: join(root, "app") };
  mkdirSync(appDirectory.path, { recursive: true });
  const context: ProjectContext = {
    root,
    appDirectory,
    installedNext: undefined,
    version: resolved("16.3.0"),
    config: undefined,
    declaredPackages: resolved(new Set<string>()),
    bundlers: resolved(new Set<Bundler>(["turbopack"])),
    typeScriptMajor: unresolved("no installed typescript in this fixture"),
    pageExtensions: resolved(DEFAULT_PAGE_EXTENSIONS),
  };
  const sources = scanSources(root);
  return {
    project: context,
    tree: buildRouteTree({
      appDirectory: appDirectory.path,
      pageExtensions: DEFAULT_PAGE_EXTENSIONS,
      isFlagEnabled: () => true,
    }),
    sources,
    graph: buildGraph(sources),
    build: { status: "unresolved", reason: "no build in this test" },
    join: EMPTY_JOIN,
    isFlagEnabled: () => true,
  };
}

const manifestNaming = (...sources: readonly string[]): string =>
  [
    "export default function manifest() {",
    "  return { name: 'x', icons: [",
    sources.map((src) => `    { src: '${src}', sizes: '1x1' },`).join("\n"),
    "  ] };",
    "}",
  ].join("\n");

function verdictOn(context: PredicateContext) {
  const predicate = METADATA_PREDICATES.find((entry) => entry.id === APP_ICONS);
  return predicate?.wouldApply?.(context, undefined as never);
}

describe("a manifest naming an icon nothing provides", () => {
  it("should report a source no file provides", () => {
    const verdict = verdictOn(project({ "app/manifest.ts": manifestNaming("/logo-512.png") }));
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("/logo-512.png");
  });

  it("should say nothing about a source served from public", () => {
    // The half a first attempt at this condition got wrong. A manifest's src is a URL, and
    // public/ serves one without any convention being involved.
    const verdict = verdictOn(
      project({
        "app/manifest.ts": manifestNaming("/logo-192.png"),
        "public/logo-192.png": "png",
      }),
    );
    expect(verdict?.matched).toBe(false);
  });

  it("should say nothing about a source the app directory provides", () => {
    const verdict = verdictOn(
      project({ "app/manifest.ts": manifestNaming("/favicon.ico"), "app/favicon.ico": "ico" }),
    );
    expect(verdict?.matched).toBe(false);
  });

  it("should name only the sources nothing provides", () => {
    const verdict = verdictOn(
      project({
        "app/manifest.ts": manifestNaming("/logo-192.png", "/logo-512.png"),
        "public/logo-192.png": "png",
      }),
    );
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("/logo-512.png");
    expect(verdict?.note).not.toContain("/logo-192.png");
  });

  it("should cite the manifest as evidence, and name the sources in the note", () => {
    // The file is where a reader looks; the source is what they go and find.
    const verdict = verdictOn(project({ "app/manifest.ts": manifestNaming("/logo-512.png") }));
    expect(verdict?.evidence.some((path) => path.endsWith("manifest.ts"))).toBe(true);
    expect(verdict?.evidence.some((path) => path.includes("logo-512"))).toBe(false);
  });

  it("should skip a source pointing at another host", () => {
    const verdict = verdictOn(
      project({ "app/manifest.ts": manifestNaming("https://cdn.example.com/logo.png") }),
    );
    expect(verdict?.matched).toBe(false);
  });

  it("should report nothing when the project declares no manifest", () => {
    expect(verdictOn(project({ "app/page.tsx": "export default () => null" }))?.matched).toBe(
      false,
    );
  });
});

const OPENGRAPH_IMAGE = "file-conventions/metadata/opengraph-image";

function socialVerdictOn(context: PredicateContext) {
  const predicate = METADATA_PREDICATES.find((entry) => entry.id === OPENGRAPH_IMAGE);
  return predicate?.wouldApply?.(context, undefined as never);
}

/**
 * The convention generates the image and the tag pointing at it from one file. A metadata object
 * naming a path under `public/` is the same two things kept apart, and the vendored project holds
 * both that and the segment where the convention already answers.
 */
describe("a metadata object naming a static social image", () => {
  const verdict = () => socialVerdictOn(fixtureContext("sparse-app"));

  it("should cite the page whose segment holds no convention", () => {
    expect(verdict()?.evidence).toEqual([fileIn("sparse-app", "app", "prensa", "page.tsx")]);
  });

  it("should say nothing about a segment that holds the convention", () => {
    expect(verdict()?.evidence).not.toContain(fileIn("sparse-app", "app", "difusion", "page.tsx"));
  });

  it("should say what generating it buys", () => {
    expect(verdict()?.gain).toContain("one file");
  });
});

describe("a social image read one value at a time", () => {
  const named = (metadata: string, files: Record<string, string> = {}) =>
    socialVerdictOn(
      project({
        "app/pagina/page.tsx": `export const metadata = ${metadata}\nexport default () => null\n`,
        "public/social.png": "png",
        ...files,
      }),
    );

  it("should read an image written as a bare string", () => {
    expect(named("{ openGraph: { images: '/social.png' } }")?.matched).toBe(true);
  });

  it("should read one written as an object carrying a url", () => {
    expect(named("{ openGraph: { images: [{ url: '/social.png' }] } }")?.matched).toBe(true);
  });

  it("should read the twitter container too", () => {
    expect(named("{ twitter: { images: ['/social.png'] } }")?.matched).toBe(true);
  });

  /**
   * A path nothing serves is a different problem, and the manifest entry already reports that one.
   * This condition is about a file that is there and a tag written out beside it by hand.
   */
  it("should say nothing about a path public does not serve", () => {
    expect(named("{ openGraph: { images: ['/ausente.png'] } }")?.matched).toBe(false);
  });

  it("should say nothing about an image assembled from a variable", () => {
    expect(named("{ openGraph: { images: [portada] } }")?.matched).toBe(false);
  });

  it("should say nothing about an absolute URL another host serves", () => {
    expect(
      named("{ openGraph: { images: ['https://cdn.ejemplo.com/social.png'] } }")?.matched,
    ).toBe(false);
  });
});

const ROBOTS = "file-conventions/metadata/robots";
const SITEMAP = "file-conventions/metadata/sitemap";

function bucketOn(id: string, context: PredicateContext) {
  const predicate = METADATA_PREDICATES.find((entry) => entry.id === id);
  const dismissed = predicate?.notApplicable?.(context, undefined as never);
  return {
    dismissed,
    suggested:
      dismissed?.matched === true
        ? undefined
        : predicate?.wouldApply?.(context, undefined as never),
  };
}

/** Two pages, which is what the sitemap condition asks for before it argues anything. */
const TWO_PAGES = {
  "app/page.tsx": "export default function Page() { return null }",
  "app/about/page.tsx": "export default function Page() { return null }",
};

describe("a robots file the project serves without the convention", () => {
  it("should suggest one where nothing answers on the URL", () => {
    const { suggested } = bucketOn(
      ROBOTS,
      project({ "app/sitemap.ts": "export default function s() { return [] }" }),
    );
    expect(suggested?.matched).toBe(true);
  });

  it("should dismiss the entry where public serves the file", () => {
    // The report told a project with a 1.2kB robots.txt announcing five sitemaps that it had none.
    const { dismissed, suggested } = bucketOn(
      ROBOTS,
      project({
        "app/sitemap.ts": "export default function s() { return [] }",
        "public/robots.txt": "User-agent: *\nSitemap: https://ejemplo.com/sitemap.xml\n",
      }),
    );
    expect(dismissed?.matched).toBe(true);
    expect(dismissed?.evidence.some((path) => path.endsWith("robots.txt"))).toBe(true);
    expect(suggested).toBeUndefined();
  });

  it("should dismiss the entry where a route handler answers on the URL", () => {
    // `app/robots.txt/route.ts` is a robots file whatever the tree calls it.
    const { dismissed } = bucketOn(
      ROBOTS,
      project({
        "app/sitemap.ts": "export default function s() { return [] }",
        "app/robots.txt/route.ts": "export function GET() { return new Response('User-agent: *') }",
      }),
    );
    expect(dismissed?.matched).toBe(true);
    expect(dismissed?.evidence.some((path) => path.endsWith("route.ts"))).toBe(true);
  });
});

describe("a sitemap the project serves without the convention", () => {
  it("should suggest one where nothing answers on the URL", () => {
    const { suggested } = bucketOn(SITEMAP, project(TWO_PAGES));
    expect(suggested?.matched).toBe(true);
  });

  it("should dismiss the entry where public serves the file", () => {
    const { dismissed, suggested } = bucketOn(
      SITEMAP,
      project({ ...TWO_PAGES, "public/sitemap.xml": "<urlset/>" }),
    );
    expect(dismissed?.matched).toBe(true);
    expect(suggested).toBeUndefined();
  });

  it("should dismiss the entry where a route handler answers on the URL", () => {
    const { dismissed } = bucketOn(
      SITEMAP,
      project({
        ...TWO_PAGES,
        "app/sitemap.xml/route.ts": "export function GET() { return new Response('<urlset/>') }",
      }),
    );
    expect(dismissed?.matched).toBe(true);
    expect(dismissed?.evidence.some((path) => path.endsWith("route.ts"))).toBe(true);
  });

  it("should say nothing about a handler answering on some other URL", () => {
    // A route handler is not a sitemap because it exists; it is one because of where it answers.
    const { dismissed, suggested } = bucketOn(
      SITEMAP,
      project({
        ...TWO_PAGES,
        "app/api/health/route.ts": "export function GET() { return new Response('ok') }",
      }),
    );
    expect(dismissed?.matched).toBe(false);
    expect(suggested?.matched).toBe(true);
  });
});
