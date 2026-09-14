import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SurfaceEntry } from "../collect/docs.js";
import { buildGraph } from "../collect/graph.js";
import { EMPTY_JOIN } from "../collect/output.js";
import type { Bundler, ProjectContext } from "../collect/project.js";
import { buildRouteTree } from "../collect/routes.js";
import { scanSources } from "../collect/sources.js";
import { DEFAULT_PAGE_EXTENSIONS, resolved, unresolved } from "../types.js";
import { conventionCoverage, ROUTING_PREDICATES, routeSegmentConfigPredicate } from "./routing.js";
import type { PredicateContext } from "./types.js";
import { reasonFor } from "./types.js";

function project(
  files: Record<string, string>,
  declaredPackages: ProjectContext["declaredPackages"] = resolved(new Set<string>()),
  isFlagEnabled: (flag: string) => boolean = () => true,
): PredicateContext {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-rsc-"));
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
    declaredPackages,
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
      // The same predicate the context carries, as the real pipeline passes it. Hard-coding `true`
      // here made the tree honour a flag-gated convention the context said was off, so a test could
      // not build the project a flag-off case is about.
      isFlagEnabled,
    }),
    sources,
    graph: buildGraph(sources),
    isFlagEnabled,
    // No build is read in these tests: every predicate here answers from source alone.
    build: unresolved("no build was read"),
    join: EMPTY_JOIN,
  };
}

function surface(id: string, title = id): SurfaceEntry {
  return {
    id,
    domain: "file-conventions",
    title,
    relatedLinks: [],
    docPath: `/docs/${id}.md`,
    frontmatterFailed: false,
    docRelativePath: "",
    docUrl: "",
    adoptable: true,
  };
}

const RSC = "file-conventions/route-segment-config";
const PAGE = "export default function Page() { return null; }";
const ASYNC_PAGE = "export default async function Page() { return null; }\n";
const SUSPENDED_PAGE = `import { Suspense } from 'react';
export default async function Page() {
  return <Suspense fallback={null}><div /></Suspense>;
}
`;

function verdictFor(entry: SurfaceEntry, context: PredicateContext) {
  const predicate = routeSegmentConfigPredicate(entry);
  if (!predicate) throw new Error(`expected a predicate for ${entry.id}`);
  return predicate.detectUsed(context, entry);
}

describe("route segment config detection", () => {
  it("should report the option as used, citing the route that declares it", () => {
    const context = project({
      "app/page.tsx": `export const runtime = 'edge';\n${PAGE}`,
    });
    const verdict = verdictFor(surface(`${RSC}/runtime`), context);
    expect(verdict.matched).toBe(true);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]).toContain("app/page.tsx");
  });

  it("should cite every route declaring the same option", () => {
    const context = project({
      "app/page.tsx": `export const runtime = 'edge';\n${PAGE}`,
      "app/about/page.tsx": `export const runtime = 'nodejs';\n${PAGE}`,
      "app/layout.tsx": `export const runtime = 'edge';\n${PAGE}`,
    });
    expect(verdictFor(surface(`${RSC}/runtime`), context).evidence).toHaveLength(3);
  });

  it("should ignore the same export outside the route conventions", () => {
    const context = project({
      "app/page.tsx": PAGE,
      "app/lib/helper.ts": "export const runtime = 'edge';",
    });
    expect(verdictFor(surface(`${RSC}/runtime`), context).matched).toBe(false);
  });

  it("should not report an option no route declares", () => {
    const context = project({ "app/page.tsx": PAGE });
    const verdict = verdictFor(surface(`${RSC}/maxDuration`), context);
    expect(verdict.matched).toBe(false);
    expect(verdict.evidence).toEqual([]);
  });

  it("should take the symbol from the identifier, not the title", () => {
    const context = project({
      "app/page.tsx": `export const preferredRegion = 'fra1';\n${PAGE}`,
    });
    // The real page is titled "preferredRegion (deprecated)". A title-derived symbol would
    // look for an export nobody declares and report this project as clean.
    const entry = surface(`${RSC}/preferredRegion`, "preferredRegion (deprecated)");
    expect(verdictFor(entry, context).matched).toBe(true);
  });

  it("should build a predicate for an option this code never names", () => {
    const invented = routeSegmentConfigPredicate(surface(`${RSC}/somethingNextAddsLater`));
    expect(invented?.id).toBe(`${RSC}/somethingNextAddsLater`);
    expect(invented?.cost).toBe("AST");
  });

  it("should build nothing for an entry outside route segment config", () => {
    expect(routeSegmentConfigPredicate(surface("functions/cacheTag"))).toBeUndefined();
    expect(routeSegmentConfigPredicate(surface(RSC))).toBeUndefined();
  });
});

function predicateFor(id: string) {
  const predicate = ROUTING_PREDICATES.find((p) => p.id === id);
  if (!predicate) throw new Error(`no predicate for ${id}`);
  return predicate;
}

const MDX = "file-conventions/mdx-components";
const MIDDLEWARE = "file-conventions/middleware";
const PROXY = "file-conventions/proxy";

describe("root file conventions", () => {
  it("should find mdx-components written as a component", () => {
    const context = project({ "mdx-components.tsx": "export function useMDXComponents() {}" });
    const verdict = predicateFor(MDX).detectUsed(context, surface(MDX));
    expect(verdict.matched).toBe(true);
    expect(verdict.evidence[0]).toContain("mdx-components.tsx");
  });

  it("should find mdx-components under src", () => {
    const context = project({ "src/mdx-components.js": "export function useMDXComponents() {}" });
    expect(predicateFor(MDX).detectUsed(context, surface(MDX)).matched).toBe(true);
  });

  it("should not report mdx-components when the project has none", () => {
    const context = project({ "app/page.tsx": PAGE });
    const verdict = predicateFor(MDX).detectUsed(context, surface(MDX));
    expect(verdict.matched).toBe(false);
    // Nor suggest it: with no MDX integration declared there is nothing arguing for the file.
    expect(predicateFor(MDX).wouldApply?.(context, surface(MDX)).matched).toBe(false);
  });

  it("should report the deprecated middleware file as used", () => {
    const context = project({ "middleware.ts": "export function middleware() {}" });
    expect(predicateFor(MIDDLEWARE).detectUsed(context, surface(MIDDLEWARE)).matched).toBe(true);
  });

  it("should keep the migration suggestion on proxy, not on middleware", () => {
    const context = project({ "middleware.ts": "export function middleware() {}" });
    expect(predicateFor(MIDDLEWARE).detectUsed(context, surface(MIDDLEWARE)).matched).toBe(true);
    expect(predicateFor(MIDDLEWARE).wouldApply).toBeUndefined();
    const nudge = predicateFor(PROXY).wouldApply?.(context, surface(PROXY));
    expect(nudge?.matched).toBe(true);
    expect(nudge?.note).toContain("deprecated");
  });

  it("should say nothing about middleware once a project has migrated", () => {
    const context = project({ "proxy.ts": "export function proxy() {}" });
    expect(predicateFor(MIDDLEWARE).detectUsed(context, surface(MIDDLEWARE)).matched).toBe(false);
    expect(predicateFor(PROXY).detectUsed(context, surface(PROXY)).matched).toBe(true);
    expect(predicateFor(PROXY).wouldApply?.(context, surface(PROXY)).matched).toBe(false);
  });

  /**
   * The reading was written from four literal names, so a project whose proxy sat under any other
   * documented page extension was reported as having none — the whole auth layer of a real starter,
   * named in no section of its report.
   */
  it.each([["proxy.tsx"], ["src/proxy.tsx"], ["proxy.mjs"], ["src/proxy.jsx"]])(
    "should find the convention at %s, an extension the default set already names",
    (name) => {
      const context = project({ [name]: "export function proxy() {}" });
      const verdict = predicateFor(PROXY).detectUsed(context, surface(PROXY));
      expect(verdict.matched).toBe(true);
      expect(verdict.evidence).toEqual([join(context.project.root, ...name.split("/"))]);
    },
  );

  /** A project's own list is the whole list: an extension it leaves out is one Next.js ignores. */
  it("should not find a proxy under an extension the project's own list omits", () => {
    const context = project({ "proxy.ts": "export function proxy() {}" });
    const narrowed: PredicateContext = {
      ...context,
      project: { ...context.project, pageExtensions: resolved(["mdx", "tsx"]) },
    };
    expect(predicateFor(PROXY).detectUsed(narrowed, surface(PROXY)).matched).toBe(false);
  });
});

describe("a convention misspelled by case", () => {
  const PAGE_ENTRY = "file-conventions/page";
  const LAYOUT_ENTRY = "file-conventions/layout";

  function verdictsFor(id: string, files: Record<string, string>) {
    const context = project(files);
    const p = predicateFor(id);
    return {
      used: p.detectUsed(context, surface(id)),
      wouldApply: p.wouldApply?.(context, surface(id)),
    };
  }

  it("should suggest the convention and name the spelling Next.js reads", () => {
    // `Page.tsx` is not a page: the framework reads nothing there, so the author has a file
    // they believe is a route and a route that does not exist.
    const { used, wouldApply } = verdictsFor(PAGE_ENTRY, { "app/about/Page.tsx": PAGE });
    expect(used.matched).toBe(false);
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence[0]).toContain("Page.tsx");
    expect(wouldApply?.note).toContain("'page'");
  });

  it("should carry it as a place the convention would still apply when used elsewhere", () => {
    const { used, wouldApply } = verdictsFor(PAGE_ENTRY, {
      "app/page.tsx": PAGE,
      "app/about/Page.tsx": PAGE,
    });
    expect(used.matched).toBe(true);
    expect(wouldApply?.matched).toBe(true);
  });

  it("should say nothing when every file is spelled correctly", () => {
    const { wouldApply } = verdictsFor(PAGE_ENTRY, { "app/page.tsx": PAGE });
    expect(wouldApply?.matched).toBe(false);
  });

  it("should apply to every routing convention, not only page", () => {
    const { wouldApply } = verdictsFor(LAYOUT_ENTRY, {
      "app/page.tsx": PAGE,
      "app/Layout.tsx": PAGE,
    });
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.note).toContain("'layout'");
  });

  it("should not confuse a component whose name merely contains the convention", () => {
    const { wouldApply } = verdictsFor(PAGE_ENTRY, {
      "app/page.tsx": PAGE,
      "app/ProfilePage.tsx": PAGE,
    });
    expect(wouldApply?.matched).toBe(false);
  });
});

describe("convention coverage by ancestry", () => {
  const at = (context: PredicateContext, segment: string) =>
    conventionCoverage(context.tree, "loading").get(
      join(context.project.appDirectory.path, segment),
    );

  it("should mark a segment that declares the convention itself", () => {
    const context = project({ "app/feed/page.tsx": PAGE, "app/feed/loading.tsx": PAGE });
    expect(at(context, "feed")).toBe(true);
  });

  it("should mark a segment covered by an ancestor", () => {
    const context = project({ "app/loading.tsx": PAGE, "app/feed/item/page.tsx": PAGE });
    expect(at(context, join("feed", "item"))).toBe(true);
  });

  it("should leave a sibling branch uncovered", () => {
    const context = project({
      "app/feed/loading.tsx": PAGE,
      "app/feed/page.tsx": PAGE,
      "app/admin/page.tsx": PAGE,
    });
    expect(at(context, "feed")).toBe(true);
    expect(at(context, "admin")).toBe(false);
  });

  it("should leave every segment uncovered when the convention is nowhere", () => {
    const context = project({ "app/feed/page.tsx": PAGE });
    expect(at(context, "feed")).toBe(false);
  });
});

describe("an uncaught not-found call", () => {
  const NOT_FOUND = "file-conventions/not-found";
  const CALLS = `import { notFound } from 'next/navigation';\nexport default function Page() { notFound(); }\n`;

  const verdicts = (files: Record<string, string>) => {
    const context = project(files);
    const p = predicateFor(NOT_FOUND);
    return {
      used: p.detectUsed(context, surface(NOT_FOUND)),
      wouldApply: p.wouldApply?.(context, surface(NOT_FOUND)),
    };
  };

  /**
   * The two root files are equivalent for this question. The installed documentation says both
   * handle unmatched URLs for the whole application, so covering a call under one and not the other
   * asserts a distinction the documentation does not draw — which is what three real apps holding
   * `app/global-not-found.tsx` were told.
   */
  it("should say nothing where a root global-not-found catches the call and the flag is on", () => {
    const context = project(
      { "app/item/page.tsx": CALLS, "app/global-not-found.tsx": PAGE },
      undefined,
      (flag) => flag === "experimental.globalNotFound",
    );
    expect(predicateFor(NOT_FOUND).wouldApply?.(context, surface(NOT_FOUND)).matched).toBe(false);
  });

  /** A file Next.js is not running catches nothing, so the call is still uncovered. */
  it("should still suggest the convention where the global-not-found flag is off", () => {
    const context = project(
      { "app/item/page.tsx": CALLS, "app/global-not-found.tsx": PAGE },
      undefined,
      () => false,
    );
    const verdict = predicateFor(NOT_FOUND).wouldApply?.(context, surface(NOT_FOUND));
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence).toEqual([join(context.project.root, "app", "item", "page.tsx")]);
  });

  /** Only the root file is the whole application's. A deep one is not this convention to Next.js. */
  it("should still suggest the convention where the global-not-found sits in a segment", () => {
    const context = project(
      { "app/item/page.tsx": CALLS, "app/item/global-not-found.tsx": PAGE },
      undefined,
      (flag) => flag === "experimental.globalNotFound",
    );
    expect(predicateFor(NOT_FOUND).wouldApply?.(context, surface(NOT_FOUND)).matched).toBe(true);
  });

  it("should suggest the convention where nothing catches the call", () => {
    const { used, wouldApply } = verdicts({ "app/item/page.tsx": CALLS });
    expect(used.matched).toBe(false);
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence[0]).toContain(join("app", "item", "page.tsx"));
    expect(wouldApply?.note).toContain("built-in page");
  });

  it("should say nothing when an ancestor declares the convention", () => {
    const { used, wouldApply } = verdicts({
      "app/not-found.tsx": PAGE,
      "app/item/page.tsx": CALLS,
    });
    expect(used.matched).toBe(true);
    expect(wouldApply?.matched).toBe(false);
  });

  it("should carry an uncovered branch while the convention is used in another", () => {
    const { used, wouldApply } = verdicts({
      "app/shop/not-found.tsx": PAGE,
      "app/shop/item/page.tsx": CALLS,
      "app/admin/page.tsx": CALLS,
    });
    expect(used.matched).toBe(true);
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence).toHaveLength(1);
    expect(wouldApply?.evidence[0]).toContain(join("app", "admin", "page.tsx"));
  });

  // A helper renders in whichever segment imports it, which the tree cannot say.
  it("should ignore a call made from a module that is not a route convention", () => {
    const { wouldApply } = verdicts({
      "app/not-found.tsx": PAGE,
      "app/lib/changelog.ts": `import { notFound } from 'next/navigation';\nexport function read() { notFound(); }\n`,
    });
    expect(wouldApply?.matched).toBe(false);
  });

  it("should suggest for a layout as readily as for a page", () => {
    const { wouldApply } = verdicts({
      "app/item/layout.tsx": `import { notFound } from 'next/navigation';\nexport default function L({ children }) { notFound(); return children; }\n`,
    });
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence[0]).toContain(join("app", "item", "layout.tsx"));
  });

  // A project-local helper of the same name is the project's own function, not the framework's.
  it("should ignore a notFound that does not come from next/navigation", () => {
    const { wouldApply } = verdicts({
      "app/item/page.tsx": `import { notFound } from '../../lib/http';\nexport default function Page() { notFound(); }\n`,
      "lib/http.ts": "export function notFound() {}\n",
    });
    expect(wouldApply?.matched).toBe(false);
  });

  it("should ignore a call made only from a test", () => {
    const { wouldApply } = verdicts({ "app/item/page.test.tsx": CALLS, "app/item/page.tsx": PAGE });
    expect(wouldApply?.matched).toBe(false);
  });

  // The graph says which segments render a helper's call, which the tree cannot. Opt-in, because
  // the graph joins files rather than symbols: see the barrel case below.
  describe("attributed through the module graph", () => {
    const HELPER = `import { notFound } from 'next/navigation';\nexport function read() { notFound(); }\n`;
    const strictVerdict = (files: Record<string, string>) =>
      predicateFor(NOT_FOUND).wouldApplyStrict?.(project(files), surface(NOT_FOUND));

    it("should suggest for a helper an uncovered route reaches", () => {
      const verdict = strictVerdict({
        "app/admin/page.tsx": `import { read } from '../lib/read';\nexport default function Page() { return read(); }\n`,
        "app/lib/read.ts": HELPER,
      });
      expect(verdict?.matched).toBe(true);
      expect(verdict?.evidence).toEqual([
        `${join("app", "admin", "page.tsx")} → ${join("app", "lib", "read.ts")}`,
      ]);
      expect(verdict?.note).toContain("built-in page");
    });

    it("should say nothing when every route reaching the helper is covered", () => {
      const verdict = strictVerdict({
        "app/not-found.tsx": PAGE,
        "app/admin/page.tsx": `import { read } from '../lib/read';\nexport default function Page() { return read(); }\n`,
        "app/lib/read.ts": HELPER,
      });
      expect(verdict?.matched).toBe(false);
    });

    it("should cite only the uncovered route when the helper is reached by both", () => {
      const verdict = strictVerdict({
        "app/shop/not-found.tsx": PAGE,
        "app/shop/page.tsx": `import { read } from '../lib/read';\nexport default function Page() { return read(); }\n`,
        "app/admin/page.tsx": `import { read } from '../lib/read';\nexport default function Page() { return read(); }\n`,
        "app/lib/read.ts": HELPER,
      });
      expect(verdict?.evidence).toEqual([
        `${join("app", "admin", "page.tsx")} → ${join("app", "lib", "read.ts")}`,
      ]);
    });

    it("should say nothing when no route reaches the helper", () => {
      const verdict = strictVerdict({
        "app/admin/page.tsx": PAGE,
        "app/lib/read.ts": HELPER,
      });
      expect(verdict?.matched).toBe(false);
    });

    // The route names one symbol from the barrel and never calls the helper. The graph cannot see
    // that, so the chain names the barrel and the reader judges the reach.
    it("should name the re-exporting module when the reach passes through a barrel", () => {
      const verdict = strictVerdict({
        "app/admin/page.tsx": `import { other } from '../lib';\nexport default function Page() { return other(); }\n`,
        "app/lib/index.ts": "export { read } from './read';\nexport { other } from './other';\n",
        "app/lib/other.ts": "export const other = () => null;\n",
        "app/lib/read.ts": HELPER,
      });
      expect(verdict?.evidence).toEqual([
        [
          join("app", "admin", "page.tsx"),
          join("app", "lib", "index.ts"),
          join("app", "lib", "read.ts"),
        ].join(" → "),
      ]);
    });

    it("should ignore a helper whose call is only in a test", () => {
      const verdict = strictVerdict({
        "app/admin/page.tsx": `import { read } from '../lib/read';\nexport default function Page() { return read(); }\n`,
        "app/lib/read.test.ts": HELPER,
      });
      expect(verdict?.matched).toBe(false);
    });
  });

  // One entry, two arguments: the tree's is proven and the graph's is not. Only the second is
  // held back, which is why the preset is carried per condition.
  describe("the preset split on this entry", () => {
    const HELPER_ONLY = {
      "app/admin/page.tsx": `import { read } from '../lib/read';\nexport default function Page() { return read(); }\n`,
      "app/lib/read.ts": `import { notFound } from 'next/navigation';\nexport function read() { notFound(); }\n`,
    };

    it("should leave the default condition silent on a helper-only project", () => {
      expect(verdicts(HELPER_ONLY).wouldApply?.matched).toBe(false);
    });

    it("should still report the casing near-miss under the default condition", () => {
      const { wouldApply } = verdicts({ ...HELPER_ONLY, "app/shop/Not-Found.tsx": PAGE });
      expect(wouldApply?.matched).toBe(true);
      expect(wouldApply?.evidence[0]).toContain(join("app", "shop", "Not-Found.tsx"));
    });

    // Only the strict condition reads the graph; the default-preset one never touches it. The
    // tier says the dearer of the two and the attribution says which performs it, so the entry's
    // own cost is free to state what every run really pays: a route-tree convention lookup.
    it("should read the graph, and say so with its cost tier", () => {
      expect(predicateFor(NOT_FOUND).conditionCost).toBe("GRAFO");
      expect(predicateFor(NOT_FOUND).conditionCostReadBy).toBe("strict");
      expect(predicateFor(NOT_FOUND).cost).toBe("FS");
    });
  });
});

describe("a streaming segment with no fallback", () => {
  const LOADING = "file-conventions/loading";

  const verdicts = (files: Record<string, string>) => {
    const context = project(files);
    const p = predicateFor(LOADING);
    return {
      used: p.detectUsed(context, surface(LOADING)),
      wouldApply: p.wouldApply?.(context, surface(LOADING)),
    };
  };

  it("should suggest the convention for an async page nothing streams for", () => {
    const { used, wouldApply } = verdicts({ "app/feed/page.tsx": ASYNC_PAGE });
    expect(used.matched).toBe(false);
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence[0]).toContain(join("app", "feed", "page.tsx"));
    expect(wouldApply?.note).toContain("await");
  });

  it("should say nothing when an ancestor declares the convention", () => {
    const { used, wouldApply } = verdicts({
      "app/loading.tsx": PAGE,
      "app/feed/page.tsx": ASYNC_PAGE,
    });
    expect(used.matched).toBe(true);
    expect(wouldApply?.matched).toBe(false);
  });

  // With nothing to await there is no interval a fallback could fill.
  it("should say nothing about a synchronous page", () => {
    const { wouldApply } = verdicts({ "app/feed/page.tsx": PAGE });
    expect(wouldApply?.matched).toBe(false);
  });

  it("should carry an uncovered branch while the convention is used in another", () => {
    const { used, wouldApply } = verdicts({
      "app/shop/loading.tsx": PAGE,
      "app/shop/page.tsx": ASYNC_PAGE,
      "app/admin/page.tsx": ASYNC_PAGE,
    });
    expect(used.matched).toBe(true);
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence).toHaveLength(1);
    expect(wouldApply?.evidence[0]).toContain(join("app", "admin", "page.tsx"));
  });

  it("should keep answering for a misspelled loading file", () => {
    const { wouldApply } = verdicts({ "app/feed/Loading.tsx": PAGE, "app/feed/page.tsx": PAGE });
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.note).toContain("'loading'");
  });

  // The convention is one of two documented ways to stream a fallback; a page that took the
  // other one has nothing to adopt.
  it("should say nothing about a page that suspends its own content", () => {
    const { wouldApply } = verdicts({ "app/feed/page.tsx": SUSPENDED_PAGE });
    expect(wouldApply?.matched).toBe(false);
  });
});

describe("a streaming segment whose fallback is declared above it", () => {
  const LOADING = "file-conventions/loading";

  const observed = (files: Record<string, string>, underCacheComponents = true) => {
    const context = project(files, undefined, (flag) =>
      flag === "cacheComponents" ? underCacheComponents : true,
    );
    return predicateFor(LOADING).wouldApplyStrict?.(context, surface(LOADING));
  };

  it("should name the page and the ancestor answering for it", () => {
    const verdict = observed({
      "app/loading.tsx": PAGE,
      "app/shop/item/page.tsx": ASYNC_PAGE,
    });
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence).toHaveLength(1);
    expect(verdict?.evidence[0]).toContain(join("app", "shop", "item", "page.tsx"));
    expect(verdict?.evidence[0]).toContain(join("app", "loading.tsx"));
    expect(verdict?.note).toContain("ancestor");
  });

  // Its own shell is exactly what the segment prerenders, so there is nothing to move.
  it("should say nothing when the segment declares its own fallback", () => {
    const verdict = observed({
      "app/loading.tsx": PAGE,
      "app/shop/loading.tsx": PAGE,
      "app/shop/page.tsx": ASYNC_PAGE,
    });
    expect(verdict?.matched).toBe(false);
  });

  // Without the flag the boundary is about navigation alone, and an ancestor's covers the page.
  it("should say nothing without cacheComponents", () => {
    const verdict = observed(
      { "app/loading.tsx": PAGE, "app/shop/item/page.tsx": ASYNC_PAGE },
      false,
    );
    expect(verdict?.matched).toBe(false);
  });

  it("should say nothing about a page that suspends its own content", () => {
    const verdict = observed({
      "app/loading.tsx": PAGE,
      "app/shop/item/page.tsx": SUSPENDED_PAGE,
    });
    expect(verdict?.matched).toBe(false);
  });

  // The uncovered case is the proven one and answers on its own; this must not repeat it.
  it("should say nothing about a page no fallback covers at all", () => {
    const verdict = observed({ "app/shop/item/page.tsx": ASYNC_PAGE });
    expect(verdict?.matched).toBe(false);
  });
});

describe("a detail route reachable only by leaving the list", () => {
  const INTERCEPTING = "file-conventions/intercepting-routes";

  const verdicts = (files: Record<string, string>) => {
    const context = project(files);
    const p = predicateFor(INTERCEPTING);
    return {
      predicate: p,
      used: p.detectUsed(context, surface(INTERCEPTING)),
      wouldApply: p.wouldApply?.(context, surface(INTERCEPTING)),
    };
  };

  it("should suggest interception for a detail page under a listing", () => {
    const { used, wouldApply } = verdicts({
      "app/feed/page.tsx": PAGE,
      "app/feed/[id]/page.tsx": PAGE,
    });
    expect(used.matched).toBe(false);
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence[0]).toContain(join("app", "feed", "[id]"));
    expect(wouldApply?.note).toContain("listing");
  });

  it("should say nothing when the route is already intercepted", () => {
    const { used, wouldApply } = verdicts({
      "app/feed/page.tsx": PAGE,
      "app/feed/[id]/page.tsx": PAGE,
      "app/feed/@modal/(.)[id]/page.tsx": PAGE,
    });
    expect(used.matched).toBe(true);
    expect(wouldApply?.matched).toBe(false);
  });

  it("should resolve an interception reaching up a level", () => {
    const { wouldApply } = verdicts({
      "app/feed/page.tsx": PAGE,
      "app/feed/[id]/page.tsx": PAGE,
      "app/other/(..)feed/[id]/page.tsx": PAGE,
    });
    expect(wouldApply?.matched).toBe(false);
  });

  it("should say nothing about a dynamic segment with no listing above it", () => {
    const { wouldApply } = verdicts({ "app/feed/[id]/page.tsx": PAGE });
    expect(wouldApply?.matched).toBe(false);
  });

  it("should be withheld from the default preset", () => {
    const { predicate } = verdicts({ "app/feed/page.tsx": PAGE });
    expect(predicate.wouldApplyPreset).toBe("strict");
  });
});

describe("mdx-components is ruled out without an MDX integration", () => {
  const dismiss = (context: PredicateContext) =>
    predicateFor(MDX).notApplicable?.(context, surface(MDX));

  it("should dismiss it when the manifest declares no MDX package", () => {
    const context = project({});
    const verdict = dismiss(context);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence).toEqual([join(context.project.root, "package.json")]);
    expect(verdict?.note).toContain("no MDX integration");
  });

  it.each(["@next/mdx", "@mdx-js/react", "next-mdx-remote"])(
    "should not dismiss it when the manifest declares %s",
    (name) => {
      expect(dismiss(project({}, resolved(new Set([name]))))?.matched).toBe(false);
    },
  );

  it("should not dismiss it when the manifest could not be read", () => {
    // An unreadable manifest declares nothing and knows nothing. Dismissing on it would rule the
    // convention out for a project that does compile MDX.
    expect(dismiss(project({}, unresolved("no manifest")))?.matched).toBe(false);
  });

  it("should still detect the file itself, whatever the manifest says", () => {
    const context = project({ "mdx-components.tsx": "export function useMDXComponents() {}" });
    expect(predicateFor(MDX).detectUsed(context, surface(MDX)).matched).toBe(true);
  });
});

describe("a segment option a config flag removes", () => {
  const ID = `${RSC}/dynamicParams`;
  const setFor = (entry: SurfaceEntry) => {
    const predicate = routeSegmentConfigPredicate(entry);
    if (!predicate) throw new Error(`expected a predicate for ${entry.id}`);
    return predicate;
  };
  const withFlag = (context: PredicateContext, enabled: boolean): PredicateContext => ({
    ...context,
    project: {
      ...context.project,
      // Only the path is read here: the flag answer comes from `isFlagEnabled`, and the object is
      // what a real configuration would carry for the predicates that parse it.
      config: {
        path: join(context.project.root, "next.config.ts"),
        object: unresolved("not parsed in this test"),
        importedObjects: new Map(),
      },
    },
    isFlagEnabled: (flag) => enabled && flag === "cacheComponents",
  });

  it("should rule the option out where the documented flag is enabled", () => {
    const context = withFlag(project({ "app/page.tsx": PAGE }), true);
    const verdict = setFor(surface(ID)).notApplicable?.(context, surface(ID));
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("cacheComponents");
  });

  it("should not rule it out where the flag is off", () => {
    const context = withFlag(project({ "app/page.tsx": PAGE }), false);
    expect(setFor(surface(ID)).notApplicable?.(context, surface(ID)).matched).toBe(false);
  });

  it("should still detect the option a project sets under the flag", () => {
    // The code is there to read. Dismissing an option the project sets would contradict it.
    const context = withFlag(
      project({ "app/page.tsx": `export const dynamicParams = false;\n${PAGE}` }),
      true,
    );
    expect(verdictFor(surface(ID), context).matched).toBe(true);
  });

  it("should leave the rest of the family alone", () => {
    for (const option of ["runtime", "maxDuration", "prefetch"]) {
      expect(setFor(surface(`${RSC}/${option}`)).notApplicable).toBeUndefined();
    }
  });

  /**
   * It took the group's fallback until the reason was split per option, and the measurement it now
   * carries is the one already written beside the flag map: the obvious heuristic fired only on
   * routes that could not set the option.
   */
  /**
   * It took the group's fallback until the reason was split per option, then a condition replaced
   * the row the split gave it. The measurement moved onto the predicate rather than being deleted:
   * what the entry answered with is still what a reader is shown beneath the finding.
   */
  it("should suggest nothing by default, and carry what was measured", () => {
    expect(setFor(surface(ID)).wouldApply).toBeUndefined();
    expect(setFor(surface(ID)).noSuggestion).toBeUndefined();
    const carried = setFor(surface(ID)).reopenedFrom;
    expect(carried?.from).toBe(ID);
    expect(carried?.why).toContain("generateStaticParams");
    expect(carried?.why).toContain("Cache Components");
  });
});

describe("conventions argued from a declared dependency", () => {
  function wouldApplyFor(id: string, context: PredicateContext) {
    const predicates = ROUTING_PREDICATES.find((candidate) => candidate.id === id);
    if (!predicates) throw new Error(`expected a predicate set for ${id}`);
    if (!predicates.wouldApply) throw new Error(`expected a would-apply condition on ${id}`);
    return predicates.wouldApply(context, surface(id));
  }

  it("should not suggest mdx-components for an MDX library that never reads it", () => {
    const context = project(
      { "app/page.tsx": PAGE },
      resolved(new Set(["next", "next-mdx-remote"])),
    );
    expect(wouldApplyFor("file-conventions/mdx-components", context).matched).toBe(false);
  });

  it("should suggest mdx-components for the integration whose docs require it", () => {
    const context = project({ "app/page.tsx": PAGE }, resolved(new Set(["next", "@next/mdx"])));
    const verdict = wouldApplyFor("file-conventions/mdx-components", context);
    expect(verdict.matched).toBe(true);
    expect(verdict.evidence[0]).toContain("package.json");
  });

  it("should not suggest instrumentation-client when only the server package is declared", () => {
    const context = project(
      { "app/page.tsx": PAGE },
      resolved(new Set(["next", "@opentelemetry/api"])),
    );
    expect(wouldApplyFor("file-conventions/instrumentation", context).matched).toBe(true);
    expect(wouldApplyFor("file-conventions/instrumentation-client", context).matched).toBe(false);
  });

  /**
   * The report listed `instrumentation-client.ts` under Used and, in the same entry, said the
   * manifest declares a package with no such file. Classification asks a used entry's condition on
   * purpose — that is what the partial-adoption channel is — so a condition arguing from an absence
   * has to establish that absence itself. Measured on cal.com, formbricks, inbox-zero and langfuse.
   */
  it("should stay silent about an instrumentation-client file the project holds", () => {
    const context = project(
      {
        "app/page.tsx": PAGE,
        "instrumentation-client.ts": "export function onRouterTransitionStart() {}\n",
      },
      resolved(new Set(["next", "@sentry/nextjs"])),
    );
    expect(wouldApplyFor("file-conventions/instrumentation-client", context).matched).toBe(false);
  });

  it("should stay silent about an instrumentation file the project holds", () => {
    const context = project(
      { "app/page.tsx": PAGE, "instrumentation.ts": "export function register() {}\n" },
      resolved(new Set(["next", "@opentelemetry/api"])),
    );
    expect(wouldApplyFor("file-conventions/instrumentation", context).matched).toBe(false);
  });

  it("should stay silent about an mdx-components file the project holds", () => {
    const context = project(
      { "app/page.tsx": PAGE, "mdx-components.tsx": "export function useMDXComponents() {}\n" },
      resolved(new Set(["next", "@next/mdx"])),
    );
    expect(wouldApplyFor("file-conventions/mdx-components", context).matched).toBe(false);
  });

  it("should find the file under src as well", () => {
    const context = project(
      {
        "app/page.tsx": PAGE,
        "src/instrumentation-client.ts": "export function onRouterTransitionStart() {}\n",
      },
      resolved(new Set(["next", "@sentry/nextjs"])),
    );
    expect(wouldApplyFor("file-conventions/instrumentation-client", context).matched).toBe(false);
  });

  it("should stay silent when the manifest could not be read", () => {
    const context = project({ "app/page.tsx": PAGE }, unresolved("no manifest was read"));
    expect(wouldApplyFor("file-conventions/instrumentation", context).matched).toBe(false);
  });
});

describe("conventions argued from a project-wide absence", () => {
  function wouldApplyFor(id: string, context: PredicateContext) {
    const predicates = ROUTING_PREDICATES.find((candidate) => candidate.id === id);
    if (!predicates?.wouldApply) throw new Error(`expected a would-apply condition on ${id}`);
    return predicates.wouldApply(context, surface(id));
  }

  const SEGMENTS = ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho"];

  it("should not suggest a route group to a root that already uses one", () => {
    const files: Record<string, string> = { "app/(shell)/page.tsx": PAGE };
    for (const name of SEGMENTS) files[`app/${name}/page.tsx`] = PAGE;
    expect(wouldApplyFor("file-conventions/route-groups", project(files)).matched).toBe(false);
  });

  it("should not suggest a route group to a project keeping its groups below the root", () => {
    // The primary fixture's shape: a flat root, and every group under a dynamic segment. The
    // convention is adopted, so there is nothing to argue for.
    const files: Record<string, string> = { "app/[lang]/(shell)/page.tsx": PAGE };
    for (const name of SEGMENTS) files[`app/${name}/page.tsx`] = PAGE;
    expect(wouldApplyFor("file-conventions/route-groups", project(files)).matched).toBe(false);
  });

  it("should not suggest a route group to a root with few segments", () => {
    const files: Record<string, string> = {};
    for (const name of SEGMENTS.slice(0, 3)) files[`app/${name}/page.tsx`] = PAGE;
    expect(wouldApplyFor("file-conventions/route-groups", project(files)).matched).toBe(false);
  });

  it("should read a route as navigation, not as an asset a public directory would serve", () => {
    const context = project({
      "app/page.tsx": "export default function Page() { return <a href='/panel'>Panel</a>; }",
    });
    expect(wouldApplyFor("file-conventions/public-folder", context).matched).toBe(false);
  });

  it("should stay silent about absolute assets when a public directory already exists", () => {
    const context = project({
      "public/logo.png": "",
      "app/page.tsx": "export default function Page() { return <img src='/logo.png' alt='' />; }",
    });
    expect(wouldApplyFor("file-conventions/public-folder", context).matched).toBe(false);
  });
});

describe("the route conventions, reopened", () => {
  const RSC_ID = (symbol: string) => `${RSC}/${symbol}`;

  function strictFor(symbol: string, context: PredicateContext) {
    const entry = surface(RSC_ID(symbol));
    const predicates = routeSegmentConfigPredicate(entry);
    return predicates?.wouldApplyStrict?.(context, entry);
  }

  /**
   * The flag is tested inside the predicate rather than left to the dismissal that runs before it.
   * What is recorded against this entry is that its obvious condition fired on four routes that
   * could not set the option; an ordering argument is how that comes back.
   */
  it("should report a route listing its params with Cache Components off", () => {
    const context = project(
      {
        "app/[id]/page.tsx": `export async function generateStaticParams() { return []; }\n${PAGE}`,
      },
      undefined,
      () => false,
    );
    const verdict = strictFor("dynamicParams", context);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("prerender");
  });

  it("should be silent on the same project with Cache Components on", () => {
    const context = project(
      {
        "app/[id]/page.tsx": `export async function generateStaticParams() { return []; }\n${PAGE}`,
      },
      undefined,
      (flag) => flag === "cacheComponents",
    );
    expect(strictFor("dynamicParams", context)?.matched).toBe(false);
  });

  it("should say nothing where the route already declares the option", () => {
    const context = project(
      {
        "app/[id]/page.tsx": [
          "export async function generateStaticParams() { return []; }",
          "export const dynamicParams = false;",
          PAGE,
        ].join("\n"),
      },
      undefined,
      () => false,
    );
    expect(strictFor("dynamicParams", context)?.matched).toBe(false);
  });

  it("should report a route every link into it turns prefetching off for", () => {
    const context = project({
      "app/informes/page.tsx": PAGE,
      "app/page.tsx": [
        "import Link from 'next/link';",
        "export default function P() { return <Link href='/informes' prefetch={false} />; }",
      ].join("\n"),
    });
    const verdict = strictFor("prefetch", context);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("/informes");
  });

  it("should say nothing where one link into the route still prefetches", () => {
    const context = project({
      "app/informes/page.tsx": PAGE,
      "app/page.tsx": [
        "import Link from 'next/link';",
        "export default function P() { return <><Link href='/informes' prefetch={false} /><Link href='/informes' /></>; }",
      ].join("\n"),
    });
    expect(strictFor("prefetch", context)?.matched).toBe(false);
  });

  /** Its page states the export only works with Cache Components enabled. */
  it("should be inert with Cache Components off", () => {
    const context = project(
      {
        "app/informes/page.tsx": PAGE,
        "app/page.tsx": [
          "import Link from 'next/link';",
          "export default function P() { return <Link href='/informes' prefetch={false} />; }",
        ].join("\n"),
      },
      undefined,
      () => false,
    );
    expect(strictFor("prefetch", context)?.matched).toBe(false);
  });

  it.each(["maxDuration", "runtime", "instant"])(
    "should report %s where no route declares it, and stay silent where one does",
    (symbol) => {
      const bare = project({ "app/layout.tsx": PAGE, "app/page.tsx": PAGE });
      expect(strictFor(symbol, bare)?.matched).toBe(true);
      const declared = project({
        "app/layout.tsx": PAGE,
        "app/page.tsx": `export const ${symbol} = 1;\n${PAGE}`,
      });
      expect(strictFor(symbol, declared)?.matched).toBe(false);
    },
  );

  it("should mark the three whose condition is their own detection inverted", () => {
    for (const symbol of ["maxDuration", "runtime", "instant"]) {
      expect(routeSegmentConfigPredicate(surface(RSC_ID(symbol)))?.restatesUsed).toBe(true);
    }
    for (const symbol of ["dynamicParams", "prefetch"]) {
      expect(routeSegmentConfigPredicate(surface(RSC_ID(symbol)))?.restatesUsed).toBeUndefined();
    }
  });

  /**
   * The fallback stays for an option a later release documents. It is what makes a seventh option
   * arrive as unexamined rather than as something silently spoken for.
   */
  it("should keep the group's sentence for an option nobody has examined", () => {
    const invented = routeSegmentConfigPredicate(surface(RSC_ID("somethingNextAddsLater")));
    expect(invented?.wouldApplyStrict).toBeUndefined();
    expect(invented?.noSuggestion?.kind).toBe("abstained");
  });

  it("should leave preferredRegion abstained on a reason of its own", () => {
    const predicates = routeSegmentConfigPredicate(surface(RSC_ID("preferredRegion")));
    expect(predicates?.wouldApplyStrict).toBeUndefined();
    const silence = predicates?.noSuggestion;
    expect(silence?.kind).toBe("abstained");
    if (silence?.kind !== "abstained") return;
    expect(silence.why).toContain("deprecated");
    // Not the group's sentence, which is what the split was for.
    expect(silence.why).not.toContain("nothing in a route argues");
  });

  it("should report a query-string identifier where no route takes one as a segment", () => {
    const context = project({
      "app/buscar/page.tsx":
        "export default function P({ searchParams }) { return searchParams.id; }",
    });
    const predicates = ROUTING_PREDICATES.find((p) => p.id === "file-conventions/dynamic-routes");
    const entry = surface("file-conventions/dynamic-routes");
    expect(predicates?.wouldApplyStrict?.(context, entry).matched).toBe(true);
  });

  it("should say nothing where the project already has a dynamic segment", () => {
    const context = project({
      "app/buscar/page.tsx":
        "export default function P({ searchParams }) { return searchParams.id; }",
      "app/[id]/page.tsx": PAGE,
    });
    const predicates = ROUTING_PREDICATES.find((p) => p.id === "file-conventions/dynamic-routes");
    const entry = surface("file-conventions/dynamic-routes");
    expect(predicates?.wouldApplyStrict?.(context, entry).matched).toBe(false);
  });

  /**
   * The fallback stays and must reach nothing the release documents. If it reached one, that option
   * would be counted as unexamined while it had in fact been spoken for.
   */
  it("should leave no documented option on the group's sentence", () => {
    const documented = [
      "dynamicParams",
      "instant",
      "maxDuration",
      "preferredRegion",
      "prefetch",
      "runtime",
    ];
    for (const symbol of documented) {
      const silence = routeSegmentConfigPredicate(surface(RSC_ID(symbol)))?.noSuggestion;
      if (silence === undefined) continue;
      expect(reasonFor(silence), symbol).not.toContain("nothing in a route argues");
    }
  });
});
