import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileIn, fixtureContext } from "../../test-support/corpus.js";
import type { BuildFiles } from "../../test-support/manifests.js";
import { writeBuild } from "../../test-support/manifests.js";
import type { SurfaceEntry } from "../collect/docs.js";
import { buildGraph } from "../collect/graph.js";
import { EMPTY_JOIN, joinRoutes, readBuildOutput } from "../collect/output.js";
import type { Bundler, ProjectContext } from "../collect/project.js";
import { buildRouteTree } from "../collect/routes.js";
import { scanSources } from "../collect/sources.js";
import { DEFAULT_PAGE_EXTENSIONS, resolved, unresolved } from "../types.js";
import { FUNCTION_SHAPES } from "./function-modules.js";
import {
  AUTH_INTERRUPTS,
  FUNCTION_PREDICATES,
  plainServerFetches,
  reasonFor,
} from "./functions.js";
import { ROUTING_PREDICATES } from "./routing.js";
import type { PredicateContext } from "./types.js";

function project(files: Record<string, string>, build?: BuildFiles): PredicateContext {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-fn-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
    // The build has to read as newer than the source, or staleness answers before anything else.
    const past = new Date(Date.now() - 60_000);
    utimesSync(full, past, past);
  }
  const appDirectory = { path: join(root, "app") };
  mkdirSync(appDirectory.path, { recursive: true });
  if (build !== undefined) writeBuild(root, build);
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
  const tree = buildRouteTree({
    appDirectory: appDirectory.path,
    pageExtensions: DEFAULT_PAGE_EXTENSIONS,
    isFlagEnabled: () => true,
  });
  const read = readBuildOutput(root, sources);
  return {
    project: context,
    tree,
    sources,
    graph: buildGraph(sources),
    isFlagEnabled: () => true,
    // Most predicates here answer from source alone, so the default is a project with no build.
    build: read.kind === "read" ? resolved(read.output) : unresolved("no build was read"),
    join: read.kind === "read" ? joinRoutes(tree, read.output, appDirectory.path) : EMPTY_JOIN,
  };
}

function surface(id: string, title: string): SurfaceEntry {
  return {
    id,
    domain: "functions",
    title,
    relatedLinks: [],
    docPath: `/docs/${id}.md`,
    frontmatterFailed: false,
    docRelativePath: "",
    docUrl: "",
    adoptable: true,
  };
}

const predicateFor = (id: string) => {
  const found = FUNCTION_PREDICATES.find((predicate) => predicate.id === id);
  if (!found) throw new Error(`no predicate for ${id}`);
  return found;
};

describe("import-anchored detection", () => {
  it("should count a symbol imported from its documented module", () => {
    const context = project({ "app/a.ts": "import { cookies } from 'next/headers'\n" });
    const verdict = predicateFor("functions/cookies").detectUsed(
      context,
      surface("functions/cookies", "cookies"),
    );
    expect(verdict.matched).toBe(true);
    expect(verdict.evidence).toHaveLength(1);
  });

  it("should ignore a project's own function of the same name", () => {
    const context = project({
      "app/a.ts": "import { headers } from './my-headers'\nexport function headers() {}\n",
    });
    const verdict = predicateFor("functions/headers").detectUsed(
      context,
      surface("functions/headers", "headers"),
    );
    expect(verdict.matched).toBe(false);
  });

  it("should follow a local alias", () => {
    const context = project({ "app/a.ts": "import { redirect as go } from 'next/navigation'\n" });
    const verdict = predicateFor("functions/redirect").detectUsed(
      context,
      surface("functions/redirect", "redirect"),
    );
    expect(verdict.matched).toBe(true);
  });

  it("should reject a type-only import as a use", () => {
    const context = project({ "app/a.ts": "import type { redirect } from 'next/navigation'\n" });
    const verdict = predicateFor("functions/redirect").detectUsed(
      context,
      surface("functions/redirect", "redirect"),
    );
    expect(verdict.matched).toBe(false);
  });

  it("should accept a type-only import for a page documenting a type", () => {
    const context = project({ "app/a.ts": "import type { NextRequest } from 'next/server'\n" });
    const verdict = predicateFor("functions/next-request").detectUsed(
      context,
      surface("functions/next-request", "NextRequest"),
    );
    expect(verdict.matched).toBe(true);
  });
});

describe("exported convention detection", () => {
  it("should count a generate function exported from a route file", () => {
    const context = project({
      "app/[slug]/page.tsx":
        "export async function generateStaticParams() { return [] }\nexport default function P() { return null }\n",
    });
    const verdict = predicateFor("functions/generate-static-params").detectUsed(
      context,
      surface("functions/generate-static-params", "generateStaticParams"),
    );
    expect(verdict.matched).toBe(true);
  });

  it("should ignore the same name outside a route file", () => {
    const context = project({
      "app/helpers.ts": "export async function generateStaticParams() { return [] }\n",
    });
    const verdict = predicateFor("functions/generate-static-params").detectUsed(
      context,
      surface("functions/generate-static-params", "generateStaticParams"),
    );
    expect(verdict.matched).toBe(false);
  });
});

describe("extended fetch detection", () => {
  it("should count a fetch carrying a next option", () => {
    const context = project({ "app/a.ts": "await fetch('/x', { next: { revalidate: 60 } })\n" });
    const verdict = predicateFor("functions/fetch").detectUsed(
      context,
      surface("functions/fetch", "fetch"),
    );
    expect(verdict.matched).toBe(true);
  });

  it("should not count a plain platform fetch", () => {
    const context = project({ "app/a.ts": "await fetch('/x')\n" });
    const verdict = predicateFor("functions/fetch").detectUsed(
      context,
      surface("functions/fetch", "fetch"),
    );
    expect(verdict.matched).toBe(false);
  });
});

/**
 * A file only runs on the Next.js server if something places it there. These four run somewhere
 * else and say so in their own contents, and every one of them was being cited by a condition
 * about server-side code on a real project.
 */
describe("files that never run on the server", () => {
  const FETCHING = "export async function load() { await fetch('https://api.example.com/x') }\n";
  const DROPPING = "async function work() {}\nexport function go() { work() }\n";

  const fetches = (context: PredicateContext) =>
    plainServerFetches(context).map((file) => file.path);
  const afterCondition = (context: PredicateContext) => {
    const predicate = predicateFor("functions/after");
    const condition = predicate.wouldApply ?? predicate.wouldApplyStrict;
    return condition?.(context, surface("functions/after", "after"));
  };

  it("should not cite a service worker for an uncached fetch", () => {
    const context = project({
      "app/sw.ts": `declare const self: ServiceWorkerGlobalScope;\n${FETCHING}`,
    });
    expect(fetches(context)).toEqual([]);
  });

  it("should not cite a service worker that registers a listener on self", () => {
    const context = project({
      "app/sw.ts": `self.addEventListener('fetch', () => {});\n${FETCHING}`,
    });
    expect(fetches(context)).toEqual([]);
  });

  it("should not cite a Pages Router component for a dropped promise", () => {
    const context = project({
      "components/delete-button.tsx": `import { useRouter } from 'next/router'\n${DROPPING}`,
    });
    expect(afterCondition(context)?.matched).toBe(false);
  });

  it("should cite a file naming next/router only in a comment", () => {
    const context = project({
      "app/page.tsx":
        "import { go } from '../lib/note'\nexport default function Page() { go(); return null }\n",
      "lib/note.ts": `// see useRouter from 'next/router'\n${DROPPING}`,
    });
    expect(afterCondition(context)?.matched).toBe(true);
  });

  it("should not cite a Node script reading its arguments", () => {
    const context = project({
      "scripts/report.ts": `const arg = process.argv[2]\n${FETCHING}${DROPPING}`,
    });
    expect(fetches(context)).toEqual([]);
    expect(afterCondition(context)?.matched).toBe(false);
  });

  it("should not cite a file opening with a shebang", () => {
    const context = project({ "scripts/report.ts": `#!/usr/bin/env node\n${FETCHING}` });
    expect(fetches(context)).toEqual([]);
  });

  it("should not cite a tool's configuration", () => {
    const context = project({ "vitest.config.ts": FETCHING });
    expect(fetches(context)).toEqual([]);
  });

  it("should still cite a config the Next.js runtime loads", () => {
    const context = project({
      // How the runtime loads it: the instrumentation hook imports it when the server starts.
      "instrumentation.ts":
        "export async function register() { await import('./sentry.server.config') }\n",
      "sentry.server.config.ts": FETCHING,
    });
    expect(fetches(context)).toHaveLength(1);
  });

  it("should still cite an ordinary server module", () => {
    const context = project({
      "app/page.tsx":
        "import { load } from '../lib/data'\nexport default async function Page() { await load(); return null }\n",
      "lib/data.ts": FETCHING,
    });
    expect(fetches(context)).toHaveLength(1);
  });

  /**
   * The signals above are what one read of a file can see. A Node script run from a `package.json`
   * line and a browser bundle kept beside the docs show none of them; what they share is that
   * nothing Next.js runs reaches them, and a module no route and no root file imports is the same.
   */
  it("should not cite a module nothing the framework runs reaches", () => {
    const context = project({ "lib/data.ts": FETCHING });
    expect(fetches(context)).toEqual([]);
  });
});

/**
 * The note states that nothing says how long the result may be reused, which is a sentence about a
 * read. A call that writes carries neither option because neither applies to it, and reporting one
 * asserts something the check never established.
 */
describe("a plain fetch read against the method it names", () => {
  const fetching = (call: string) =>
    plainServerFetches(project({ "app/page.tsx": `${call}\n` })).length;

  it("should report a call that names no method", () => {
    expect(fetching("await fetch('https://api.ejemplo.com/x')")).toBe(1);
  });

  it("should report a call naming get, whatever its case", () => {
    expect(fetching("await fetch('https://api.ejemplo.com/x', { method: 'GET' })")).toBe(1);
  });

  it("should leave a call that writes alone", () => {
    expect(
      fetching("await fetch('https://api.ejemplo.com/x', { method: 'POST', body: '{}' })"),
    ).toBe(0);
  });

  it("should leave a call whose method is an expression alone", () => {
    expect(fetching("await fetch('https://api.ejemplo.com/x', { method: verbo })")).toBe(0);
  });
});

describe("single-file would-apply conditions", () => {
  it("should suggest cacheLife for a cache scope that sets none", () => {
    const context = project({ "app/a.ts": "'use cache'\nexport const x = 1\n" });
    const verdict = predicateFor("functions/cacheLife").wouldApply?.(
      context,
      surface("functions/cacheLife", "cacheLife"),
    );
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence).toHaveLength(1);
  });

  it("should stay silent when the cache scope already sets a lifetime", () => {
    const context = project({
      "app/a.ts": "'use cache'\nimport { cacheLife } from 'next/cache'\ncacheLife('hours')\n",
    });
    const verdict = predicateFor("functions/cacheLife").wouldApply?.(
      context,
      surface("functions/cacheLife", "cacheLife"),
    );
    expect(verdict?.matched).toBe(false);
  });

  it("should suggest cacheTag for a cache scope with no tag", () => {
    const context = project({ "app/a.ts": "'use cache'\nexport const x = 1\n" });
    const verdict = predicateFor("functions/cacheTag").wouldApply?.(
      context,
      surface("functions/cacheTag", "cacheTag"),
    );
    expect(verdict?.matched).toBe(true);
  });

  it("should flag a server action file importing no invalidation function", () => {
    const context = project({
      "app/actions.ts": "'use server'\nexport async function save() {}\n",
    });
    const verdict = predicateFor("functions/revalidateTag").wouldApply?.(
      context,
      surface("functions/revalidateTag", "revalidateTag"),
    );
    expect(verdict?.matched).toBe(true);
  });

  /**
   * The reading observes an absent import and nothing else. Saying "any mutation in them leaves the
   * UI stale" asserted the mutation it never established, and a real project's `logIn`/`logOut` —
   * which read and set a cookie — was told its UI was stale. A regression to diagnostic wording
   * fails here rather than waiting for a second external survey.
   */
  it("should say what it observed without asserting a mutation", () => {
    const context = project({
      "app/actions.ts": "'use server'\nexport async function save() {}\n",
    });
    const verdict = predicateFor("functions/revalidateTag").wouldApply?.(
      context,
      surface("functions/revalidateTag", "revalidateTag"),
    );
    expect(verdict?.note).toContain("import none of the invalidation functions");
    expect(verdict?.note).not.toContain("stale");
    expect(verdict?.note).not.toContain("mutation");
    // The gain is where the benefit belongs, and it is stated conditionally.
    expect(verdict?.gain).toContain("where one of them writes");
  });

  it("should stay silent when the server action already invalidates", () => {
    const context = project({
      "app/actions.ts":
        "'use server'\nimport { revalidatePath } from 'next/cache'\nexport async function save() { revalidatePath('/') }\n",
    });
    const verdict = predicateFor("functions/revalidateTag").wouldApply?.(
      context,
      surface("functions/revalidateTag", "revalidateTag"),
    );
    expect(verdict?.matched).toBe(false);
  });

  it("should suggest generateStaticParams for a dynamic page without it", () => {
    const context = project({
      "app/[slug]/page.tsx": "export default function P() { return null }\n",
    });
    const verdict = predicateFor("functions/generate-static-params").wouldApply?.(
      context,
      surface("functions/generate-static-params", "generateStaticParams"),
    );
    expect(verdict?.matched).toBe(true);
  });
});

/**
 * The condition argues that a route is not prerendered, and the build is what prerenders. Where
 * the build answered, the answer settles it: the suggestion is withdrawn for that route rather
 * than printed beside the measurement refuting it.
 */
describe("a measurement that answers the shape", () => {
  const PAGE = "export default function P() { return null }\n";
  const staticParams = (context: PredicateContext) =>
    predicateFor("functions/generate-static-params").wouldApply?.(
      context,
      surface("functions/generate-static-params", "generateStaticParams"),
    );

  function build(dynamicRoutes: Record<string, unknown>, appPaths: Record<string, string>) {
    return {
      buildId: "test-build",
      prerender: { version: 4, routes: {}, dynamicRoutes },
      appPaths,
    };
  }

  it("should withdraw a route the build recorded as partially static", () => {
    const context = project(
      { "app/[slug]/page.tsx": PAGE },
      build(
        { "/[slug]": { renderingMode: "PARTIALLY_STATIC", fallback: "/[slug]" } },
        { "/[slug]/page": "/[slug]" },
      ),
    );
    expect(staticParams(context)?.matched).toBe(false);
  });

  it("should withdraw a route the build recorded as static", () => {
    const context = project(
      { "app/[slug]/page.tsx": PAGE },
      build(
        { "/[slug]": { renderingMode: "STATIC", fallback: "/[slug]" } },
        { "/[slug]/page": "/[slug]" },
      ),
    );
    expect(staticParams(context)?.matched).toBe(false);
  });

  it("should keep the routes the build did not prerender", () => {
    const context = project(
      {
        "app/[slug]/page.tsx": PAGE,
        "app/[id]/page.tsx": PAGE,
        "app/[tag]/page.tsx": PAGE,
        "app/[name]/page.tsx": PAGE,
      },
      build(
        { "/[slug]": { renderingMode: "STATIC", fallback: "/[slug]" } },
        {
          "/[slug]/page": "/[slug]",
          "/[id]/page": "/[id]",
          "/[tag]/page": "/[tag]",
          "/[name]/page": "/[name]",
        },
      ),
    );
    const verdict = staticParams(context);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence).toHaveLength(3);
    expect(verdict?.evidence.some((path) => path.includes("[slug]"))).toBe(false);
  });

  it("should keep a route the build's mapping does not list", () => {
    const context = project({ "app/[slug]/page.tsx": PAGE }, build({}, {}));
    expect(staticParams(context)?.matched).toBe(true);
  });

  it("should report in full when there is no build to answer", () => {
    const context = project({ "app/[slug]/page.tsx": PAGE });
    expect(staticParams(context)?.matched).toBe(true);
  });

  /**
   * The tier says what a run has to do to reach the answer, and this condition reaches it from
   * source. Declaring `BUILD` would send it to the not-evaluated bucket on every project without
   * one, losing a finding the source alone establishes — so the boundary is asserted here rather
   * than left to whoever next edits the condition.
   */
  it("should stay at the tier of the reading that selects the routes", () => {
    expect(predicateFor("functions/generate-static-params").cost).toBe("AST");
  });
});

describe("opt-in preset", () => {
  /**
   * One entry carries the family's suggestion and the rest delegate to it, so only the carrier has
   * a preset to mark. Asserting all four would pass again the day the collapse is undone.
   */
  it("should mark the server action heuristic as strict only, on the entry that carries it", () => {
    expect(predicateFor("functions/revalidateTag").wouldApplyPreset).toBe("strict");
    for (const symbol of ["revalidatePath", "updateTag", "refresh"]) {
      const predicate = predicateFor(`functions/${symbol}`);
      expect(predicate.wouldApply).toBeUndefined();
      expect(predicate.noSuggestion).toMatchObject({
        kind: "delegated",
        to: "functions/revalidateTag",
      });
    }
  });

  it("should keep the provable heuristics in the default preset", () => {
    for (const id of [
      "functions/cacheLife",
      "functions/cacheTag",
      "functions/generate-static-params",
    ]) {
      expect(predicateFor(id).wouldApplyPreset).toBeUndefined();
    }
  });
});

describe("authored shape map", () => {
  it("should declare a shape for every function predicate", () => {
    for (const predicate of FUNCTION_PREDICATES) {
      expect(FUNCTION_SHAPES[predicate.id]).toBeDefined();
    }
  });

  // Detection is an import in every case, so the tier follows the condition rather than the
  // entry: only the conditions listed below read the graph.
  /**
   * The tier is a statement about what a condition reads, so it is named per id rather than
   * asserted of the domain. Twelve read the graph: eight whose evidence it selects, and four that
   * use it only to remove server-side candidates one read selected. `graph-reading.test.ts`
   * measures both against the fixtures; this pins the list so a change to it is deliberate.
   */
  it("should name the function predicates that read how the files reference each other", () => {
    const byTier = FUNCTION_PREDICATES.filter(
      (predicate) => predicate.conditionCost !== undefined,
    ).map((predicate) => predicate.id);
    expect([...byTier].sort()).toEqual([
      "functions/after",
      "functions/catchError",
      "functions/fetch",
      "functions/next-root-params",
      "functions/permanentRedirect",
      "functions/redirect",
      "functions/unstable_rethrow",
      "functions/use-params",
      "functions/use-pathname",
      "functions/use-router",
      "functions/use-search-params",
      "functions/use-selected-layout-segment",
    ]);
    // And the entry's own tier stays what its detection reads. Asserting the graph on `cost` is
    // what this test used to do, which said every default run over these five walks the graph.
    expect(FUNCTION_PREDICATES.filter((predicate) => predicate.cost !== "AST")).toEqual([]);
  });
});

const NO_STORE = "import { unstable_noStore } from 'next/cache'\nexport const dynamic = true\n";

/** The same project under either flag state, which is what selects between the two entries. */
function withCacheComponents(files: Record<string, string>, enabled: boolean): PredicateContext {
  return {
    ...project(files),
    isFlagEnabled: (flag) => (flag === "cacheComponents" ? enabled : false),
  };
}

function wouldApplyOf(id: string, context: PredicateContext) {
  const predicate = predicateFor(id).wouldApply;
  if (predicate === undefined) throw new Error(`no wouldApply for ${id}`);
  return predicate(context, surface(id, id.split("/").at(-1) ?? ""));
}

describe("the opt-out Next.js replaced", () => {
  const importer = { "app/panel/page.tsx": NO_STORE };

  it("should suggest connection when cacheComponents is off", () => {
    const verdict = wouldApplyOf("functions/connection", withCacheComponents(importer, false));
    expect(verdict.matched).toBe(true);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.note).toContain("legacy");
    expect(wouldApplyOf("functions/io", withCacheComponents(importer, false)).matched).toBe(false);
  });

  it("should suggest io instead when cacheComponents is on", () => {
    const verdict = wouldApplyOf("functions/io", withCacheComponents(importer, true));
    expect(verdict.matched).toBe(true);
    expect(verdict.note).toContain("cacheComponents");
    expect(wouldApplyOf("functions/connection", withCacheComponents(importer, true)).matched).toBe(
      false,
    );
  });

  it("should treat a flag it could not read as off, so connection is the suggestion", () => {
    // `isFlagEnabled` is false both when the flag is off and when the config could not be read:
    // the two are one case by construction, and it is the case that selects `connection`. `io`
    // exists only under cache components, so suggesting it here would name an unavailable API.
    const unreadableConfig = { ...project(importer), isFlagEnabled: () => false };
    expect(wouldApplyOf("functions/connection", unreadableConfig).matched).toBe(true);
    expect(wouldApplyOf("functions/io", unreadableConfig).matched).toBe(false);
  });

  it("should suggest neither when only a test imports it", () => {
    const tests = { "app/panel/page.test.tsx": NO_STORE };
    expect(wouldApplyOf("functions/connection", withCacheComponents(tests, false)).matched).toBe(
      false,
    );
    expect(wouldApplyOf("functions/io", withCacheComponents(tests, true)).matched).toBe(false);
  });

  it("should suggest neither when nothing imports it", () => {
    const clean = { "app/panel/page.tsx": "export default function Page() { return null }\n" };
    expect(wouldApplyOf("functions/connection", withCacheComponents(clean, false)).matched).toBe(
      false,
    );
    expect(wouldApplyOf("functions/io", withCacheComponents(clean, true)).matched).toBe(false);
  });

  it("should state what the documentation says without naming the code or the developer", () => {
    for (const [id, enabled] of [
      ["functions/connection", false],
      ["functions/io", true],
    ] as const) {
      const note = wouldApplyOf(id, withCacheComponents(importer, enabled)).note ?? "";
      expect(note).toContain("unstable_noStore");
      expect(note).not.toMatch(/should|must|wrong|fix|bad|you /i);
    }
  });
});

describe("generateSitemaps is ruled out with no sitemap to generate from", () => {
  const ID = "functions/generate-sitemaps";
  const dismiss = (context: PredicateContext) =>
    predicateFor(ID).notApplicable?.(context, surface(ID, "generateSitemaps"));

  it("should dismiss it when the app directory holds no sitemap", () => {
    const context = project({ "app/page.tsx": "export default () => null\n" });
    const verdict = dismiss(context);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence).toEqual([context.project.appDirectory.path]);
    expect(verdict?.note).toContain("no sitemap");
  });

  it("should not dismiss it when a sitemap convention exists", () => {
    const context = project({ "app/sitemap.ts": "export default () => []\n" });
    expect(dismiss(context)?.matched).toBe(false);
  });

  it("should carry evidence on every dismissal, so the bucket can be checked", () => {
    const context = project({ "app/page.tsx": "export default () => null\n" });
    const verdict = dismiss(context);
    expect(verdict?.matched && verdict.evidence.length > 0).toBe(true);
  });
});

describe("the auth interrupt functions are gated like their conventions", () => {
  it.each(["functions/forbidden", "functions/unauthorized"])(
    "should declare the documented flag on %s",
    (id) => {
      expect(predicateFor(id).requiredFlag).toBe(AUTH_INTERRUPTS);
    },
  );

  it("should gate the functions on the same flag as the file conventions of the same name", () => {
    // One documentation page states the requirement for both halves. They drifted apart once,
    // and the functions spent that time reported as backlog on projects that cannot call them.
    for (const name of ["forbidden", "unauthorized"]) {
      const convention = ROUTING_PREDICATES.find((p) => p.id === `file-conventions/${name}`);
      expect(convention?.requiredFlag).toBe(predicateFor(`functions/${name}`).requiredFlag);
    }
  });

  it("should still detect the call itself, which the flag does not change", () => {
    const context = project({ "app/a.ts": "import { forbidden } from 'next/navigation'\n" });
    const verdict = predicateFor("functions/forbidden").detectUsed(
      context,
      surface("functions/forbidden", "forbidden"),
    );
    expect(verdict.matched).toBe(true);
  });

  /**
   * Both were reopened, so the measurement moved off `noSuggestion` and onto the predicate that
   * replaced it. What the test holds is unchanged: neither argues in the default preset, and the
   * sentence the entry used to answer with is still the one a reader is shown.
   */
  it("should suggest neither by default, and carry what was measured", () => {
    for (const id of ["functions/forbidden", "functions/unauthorized"]) {
      expect(predicateFor(id).wouldApply).toBeUndefined();
      expect(predicateFor(id).noSuggestion).toBeUndefined();
      const carried = predicateFor(id).reopenedFrom;
      expect(carried?.from, id).toBe(id);
      expect(carried?.why, id).toContain("has no render to interrupt");
    }
  });
});

describe("a suggestion that exists is not a backlog", () => {
  const NO_STORE = "functions/unstable_noStore";

  it("should delegate unstable_noStore rather than call it unwritten", () => {
    const entry = FUNCTION_PREDICATES.find((predicate) => predicate.id === NO_STORE);
    // Its condition is written: `functions/connection` fires on the files importing it, and
    // `functions/io` does under Cache Components. Reporting it as unwritten told the reader
    // nobody had looked, and pointed nowhere.
    expect(entry?.noSuggestion).toMatchObject({ kind: "delegated", to: "functions/connection" });
  });

  it("should name a target every supported version documents", () => {
    // A delegation is a static pointer resolved against the derived surface. 16.2.6 has no `io`
    // page, so naming `io` would dangle on the contrast fixture.
    const entry = FUNCTION_PREDICATES.find((predicate) => predicate.id === NO_STORE);
    const to = entry?.noSuggestion?.kind === "delegated" ? entry.noSuggestion.to : undefined;
    expect(to).not.toBe("functions/io");
    expect(FUNCTION_PREDICATES.some((predicate) => predicate.id === to)).toBe(true);
  });

  it("should leave no function claiming a condition is still pending", () => {
    // Every candidate has been measured. A function reporting unwritten now is one someone
    // added without measuring it, which is what this asserts against.
    const unwritten = FUNCTION_PREDICATES.filter(
      (predicate) => predicate.noSuggestion?.kind === "unwritten",
    );
    expect(unwritten.map((predicate) => predicate.id)).toEqual([]);
  });
});

describe("a measured candidate is not a backlog", () => {
  const MEASURED = [
    "functions/next-response",
    "functions/use-pathname",
    "functions/headers",
    "functions/next-root-params",
    "functions/use-offline",
  ] as const;

  /**
   * All five were reopened, so the sentence they were measured with now rides on the predicate
   * rather than sitting in `noSuggestion`. Read off whichever field holds it: what the contract
   * promises is that the measurement survives, not which side of a conversion it ends up on.
   */
  it("should state what was measured rather than reporting work as pending", () => {
    for (const id of MEASURED) {
      const entry = FUNCTION_PREDICATES.find((predicate) => predicate.id === id);
      const reason = entry?.noSuggestion;
      const why = reason?.kind === "abstained" ? reason.why : entry?.reopenedFrom?.why;
      expect(why, id).toBeDefined();
      // The fallback's wording is what these carried before. Reusing it would be the same
      // borrowed-reason problem the config group already has a guard for.
      expect(why, id).not.toBe("no condition written for reaching for this function");
      expect((why ?? "").length, id).toBeGreaterThan(30);
    }
  });

  it("should keep the unwritten kind available for a condition that is genuinely pending", () => {
    // Nothing here removes the kind. An id in neither map still reports it, so a future
    // condition believed to exist and unwritten still has a word and is still counted.
    const invented = reasonFor("functions/does-not-exist");
    expect(invented.kind).toBe("unwritten");
  });
});

describe("a layout rendering a component that reads the pathname", () => {
  const SEGMENT = "functions/use-selected-layout-segment";
  const NAV = `'use client';
import { usePathname } from 'next/navigation';
export function Nav() { return <span>{usePathname()}</span>; }
`;

  const observed = (files: Record<string, string>) =>
    predicateFor(SEGMENT).wouldApplyStrict?.(
      project(files),
      surface(SEGMENT, "useSelectedLayoutSegment"),
    );

  it("should name the layout and the component it renders", () => {
    const verdict = observed({
      "app/layout.tsx": `import { Nav } from './nav';\nexport default function Layout() { return <Nav />; }\n`,
      "app/nav.tsx": NAV,
    });
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence).toHaveLength(1);
    expect(verdict?.evidence[0]).toContain(join("app", "layout.tsx"));
    expect(verdict?.evidence[0]).toContain(join("app", "nav.tsx"));
    expect(verdict?.note).toContain("segment");
  });

  // The hook answers a question a layout asks. A page reading the pathname is asking its own.
  it("should say nothing when only a page renders the component", () => {
    const verdict = observed({
      "app/page.tsx": `import { Nav } from './nav';\nexport default function Page() { return <Nav />; }\n`,
      "app/nav.tsx": NAV,
    });
    expect(verdict?.matched).toBe(false);
  });

  it("should follow the chain through the modules between them", () => {
    const verdict = observed({
      "app/layout.tsx": `import { Shell } from './shell';\nexport default function Layout() { return <Shell />; }\n`,
      "app/shell.tsx": `import { Nav } from './nav';\nexport function Shell() { return <Nav />; }\n`,
      "app/nav.tsx": NAV,
    });
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence[0]).toContain("→");
    expect(verdict?.evidence[0]).toContain(join("app", "shell.tsx"));
  });

  it("should ignore a test that mocks the hook", () => {
    const verdict = observed({
      "app/layout.tsx": `import { Nav } from './nav.test';\nexport default function Layout() { return <Nav />; }\n`,
      "app/nav.test.tsx": NAV,
    });
    expect(verdict?.matched).toBe(false);
  });

  // The graph is what joins a layout to a component several modules below it — and it is the
  // condition that walks it. Detection here is an import match, which every run pays and the
  // entry's own tier states.
  it("should declare the graph tier", () => {
    expect(predicateFor(SEGMENT).conditionCost).toBe("GRAFO");
    expect(predicateFor(SEGMENT).cost).toBe("AST");
  });

  // One question, one answer: the plural hook reports through the singular rather than beside it.
  it("should have the plural hook delegate to it", () => {
    const plural = predicateFor("functions/use-selected-layout-segments");
    expect(plural.noSuggestion).toMatchObject({ kind: "delegated", to: SEGMENT });
  });
});

/**
 * The narrowed metadata shape, against the vendored project that holds all three cases: a page
 * under a dynamic segment with nothing above it, a page under a dynamic segment whose layout
 * states the title, and a page under no dynamic segment at all.
 */
describe("a page that cannot vary its metadata per entity", () => {
  const verdict = () => {
    const predicate = predicateFor("functions/generate-metadata").wouldApply;
    if (!predicate) throw new Error("generate-metadata carries no would-apply condition");
    return predicate(
      fixtureContext("incomplete-app"),
      surface("functions/generate-metadata", "generateMetadata"),
    );
  };

  it("should cite the page under a dynamic segment with no metadata above it", () => {
    expect(verdict().evidence).toEqual([
      fileIn("incomplete-app", "app", "articulo", "[slug]", "page.tsx"),
    ]);
  });

  it("should not cite a page whose layout above states the title", () => {
    expect(verdict().evidence).not.toContain(
      fileIn("incomplete-app", "app", "catalogo", "[id]", "page.tsx"),
    );
  });

  it("should not cite a page under no dynamic segment", () => {
    expect(verdict().evidence).not.toContain(
      fileIn("incomplete-app", "app", "catalogo", "page.tsx"),
    );
  });

  it("should say what the function buys", () => {
    expect(verdict().gain).toContain("resolved params");
  });
});

/**
 * The viewport fields the framework moved out of metadata, against the vendored project that
 * carries one object with them and one without.
 */
describe("viewport keys inside a metadata object", () => {
  const verdict = () => {
    const predicate = predicateFor("functions/generate-viewport").wouldApply;
    if (!predicate) throw new Error("generate-viewport carries no would-apply condition");
    return predicate(
      fixtureContext("sparse-app"),
      surface("functions/generate-viewport", "generateViewport"),
    );
  };

  it("should cite the file whose metadata object still carries one", () => {
    expect(verdict().evidence).toEqual([fileIn("sparse-app", "app", "ajustes", "page.tsx")]);
  });

  it("should not cite a metadata object carrying none of them", () => {
    expect(verdict().evidence).not.toContain(fileIn("sparse-app", "app", "informe", "page.tsx"));
  });

  it("should say where the framework reads them now", () => {
    expect(verdict().gain).toContain("viewport export");
  });
});

/**
 * The conditions written in place of a product abstention. Each with a shape that reports and the
 * negative its own objection names, because a condition that fires on the shape and on its opposite
 * has not been narrowed at all.
 */
describe("the product abstentions, reopened", () => {
  function strictVerdict(id: string, context: PredicateContext) {
    const found = FUNCTION_PREDICATES.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no predicate for ${id}`);
    return found.wouldApplyStrict?.(context, surface(id, id.split("/").at(-1) ?? id));
  }

  const CLIENT = "'use client';\n";

  describe("the three that follow a chain of files", () => {
    const THROWER = [
      "import { notFound } from 'next/navigation';",
      "export function load() { notFound(); }",
    ].join("\n");

    it("should report a catch that reaches a module throwing a framework signal", () => {
      const context = project({
        "app/page.tsx": [
          "import { load } from '../lib/load.js';",
          "export default function P() { try { load(); } catch (e) { return null; } }",
        ].join("\n"),
        "lib/load.ts": THROWER,
      });
      const verdict = strictVerdict("functions/unstable_rethrow", context);
      expect(verdict?.matched).toBe(true);
      expect(verdict?.note).toContain("never rethrow");
    });

    /**
     * The shape formbricks holds three times: the file's one `try` wraps a call into a module that
     * throws nothing, and the call that does reach a thrower sits outside every `try`. Nothing is
     * swallowed, so there is nothing to report.
     */
    it("should say nothing where the try wraps a different call", () => {
      const context = project({
        "app/page.tsx": [
          "import { load } from '../lib/load.js';",
          "import { other } from '../lib/other.js';",
          "export default function P() {",
          "  load();",
          "  try { other(); } catch (e) { return null; }",
          "}",
        ].join("\n"),
        "lib/load.ts": THROWER,
        "lib/other.ts": "export function other() { return 1; }",
      });
      expect(strictVerdict("functions/unstable_rethrow", context)?.matched).toBe(false);
    });

    it("should report a file calling the same module inside and outside a try", () => {
      const context = project({
        "app/page.tsx": [
          "import { load } from '../lib/load.js';",
          "export default function P() {",
          "  load();",
          "  try { load(); } catch (e) { return null; }",
          "}",
        ].join("\n"),
        "lib/load.ts": THROWER,
      });
      expect(strictVerdict("functions/unstable_rethrow", context)?.matched).toBe(true);
    });

    it("should follow the alias the call site holds", () => {
      const context = project({
        "app/page.tsx": [
          "import { load as run } from '../lib/load.js';",
          "export default function P() { try { run(); } catch (e) { return null; } }",
        ].join("\n"),
        "lib/load.ts": THROWER,
      });
      expect(strictVerdict("functions/unstable_rethrow", context)?.matched).toBe(true);
    });

    it("should say nothing where the try has only a finally", () => {
      const context = project({
        "app/page.tsx": [
          "import { load } from '../lib/load.js';",
          "export default function P() { try { load(); } finally { return null; } }",
        ].join("\n"),
        "lib/load.ts": THROWER,
      });
      expect(strictVerdict("functions/unstable_rethrow", context)?.matched).toBe(false);
    });

    it("should say nothing where the catch already rethrows", () => {
      const context = project({
        "app/page.tsx": [
          "import { unstable_rethrow } from 'next/navigation';",
          "import { load } from '../lib/load.js';",
          "export default function P() { try { load(); } catch (e) { unstable_rethrow(e); } }",
        ].join("\n"),
        "lib/load.ts": THROWER,
      });
      expect(strictVerdict("functions/unstable_rethrow", context)?.matched).toBe(false);
    });

    it("should say nothing where nothing below the catch throws a signal", () => {
      const context = project({
        "app/page.tsx": [
          "import { load } from '../lib/load.js';",
          "export default function P() { try { load(); } catch (e) { return null; } }",
        ].join("\n"),
        "lib/load.ts": "export function load() { return 1; }",
      });
      expect(strictVerdict("functions/unstable_rethrow", context)?.matched).toBe(false);
    });

    it("should never cite a test file", () => {
      const context = project({
        "app/page.tsx": "export default function P() { return null; }",
        "app/page.test.tsx": [
          "import { load } from '../lib/load.js';",
          "export function t() { try { load(); } catch (e) {} }",
        ].join("\n"),
        "lib/load.ts": THROWER,
      });
      expect(strictVerdict("functions/unstable_rethrow", context)?.matched).toBe(false);
    });

    it("should report a root parameter read two forwards below the segment", () => {
      const context = project({
        "app/[lang]/page.tsx": [
          "import { Panel } from '../../components/panel.js';",
          "export default function P({ params }) { return <Panel params={params} />; }",
        ].join("\n"),
        "components/panel.tsx": [
          "import { Inner } from './inner.js';",
          "export function Panel({ params }) { return <Inner params={params} />; }",
        ].join("\n"),
        "components/inner.tsx": "export function Inner({ params }) { return params.lang; }",
      });
      expect(strictVerdict("functions/next-root-params", context)?.matched).toBe(true);
    });

    it("should say nothing where the segment's own file reads the parameter", () => {
      const context = project({
        "app/[lang]/page.tsx": "export default function P({ params }) { return params.lang; }",
      });
      expect(strictVerdict("functions/next-root-params", context)?.matched).toBe(false);
    });

    it("should report a hand-rolled boundary reached from the error convention", () => {
      const context = project({
        "app/error.tsx": [
          CLIENT,
          "import { Boundary } from '../components/boundary.js';",
          "export default function E() { return <Boundary />; }",
        ].join("\n"),
        "components/boundary.tsx": [
          CLIENT,
          "import { Component } from 'react';",
          "export class Boundary extends Component { render() { return null; } }",
        ].join("\n"),
      });
      expect(strictVerdict("functions/catchError", context)?.matched).toBe(true);
    });
  });

  describe("the hand-rolled equivalents", () => {
    it.each([
      ["functions/use-router", "window.location.href = '/a';"],
      ["functions/use-pathname", "return location.pathname;"],
      ["functions/use-search-params", "return new URLSearchParams(location.search);"],
    ])("should report a client file doing by hand what %s covers", (id, body) => {
      const context = project({
        "app/page.tsx": [CLIENT, `export default function P() { ${body} }`].join(""),
      });
      expect(strictVerdict(id, context)?.matched).toBe(true);
    });

    it("should say nothing about the same shape on the server", () => {
      const context = project({
        "app/page.tsx": "export default function P() { return location.pathname; }",
      });
      expect(strictVerdict("functions/use-pathname", context)?.matched).toBe(false);
    });

    it("should report a file that reads the user-agent header and matches it", () => {
      const context = project({
        "app/page.tsx": [
          "export default function P(h) { return h.get('user-agent').includes('bot'); }",
        ].join(""),
      });
      expect(strictVerdict("functions/userAgent", context)?.matched).toBe(true);
    });

    /** The recorded objection honoured: reading it and passing it on is not the shape. */
    it("should say nothing where the header is read and passed on", () => {
      const context = project({
        "app/page.tsx": "export default function P(h) { return send(h.get('user-agent')); }",
      });
      expect(strictVerdict("functions/userAgent", context)?.matched).toBe(false);
    });

    it("should report a server module dropping a promise before it returns", () => {
      const context = project({
        "app/page.tsx": [
          "async function log() {}",
          "export default function P() { log(); return null; }",
        ].join("\n"),
      });
      expect(strictVerdict("functions/after", context)?.matched).toBe(true);
    });

    it("should say nothing where the same call is awaited", () => {
      const context = project({
        "app/page.tsx": [
          "async function log() {}",
          "export default async function P() { await log(); return null; }",
        ].join("\n"),
      });
      expect(strictVerdict("functions/after", context)?.matched).toBe(false);
    });

    it("should report a handler taking the request URL apart by hand", () => {
      const context = project({
        "app/api/a/route.ts": "export function GET(request) { return new URL(request.url); }",
      });
      expect(strictVerdict("functions/next-request", context)?.matched).toBe(true);
    });

    it("should say nothing where the handler already uses the typed request", () => {
      const context = project({
        "app/api/a/route.ts": [
          "import { NextRequest } from 'next/server';",
          "export function GET(request: NextRequest) { return new URL(request.url); }",
        ].join("\n"),
      });
      expect(strictVerdict("functions/next-request", context)?.matched).toBe(false);
    });

    it("should report a handler stringifying its own JSON body", () => {
      const context = project({
        "app/api/a/route.ts": "export function GET() { return new Response(JSON.stringify({})); }",
      });
      expect(strictVerdict("functions/next-response", context)?.matched).toBe(true);
    });
  });

  describe("the navigation group", () => {
    it.each([
      ["functions/redirect", 307],
      ["functions/permanentRedirect", 308],
    ])("should report %s from the status literal that decides it", (id, status) => {
      const context = project({
        "app/page.tsx": `export default function P() { return new Response(null, { status: ${status} }); }`,
      });
      expect(strictVerdict(id, context)?.matched).toBe(true);
      const other =
        id === "functions/redirect" ? "functions/permanentRedirect" : "functions/redirect";
      expect(strictVerdict(other, context)?.matched).toBe(false);
    });

    /** A handler answering with a redirect is doing what a handler is for: no render to interrupt. */
    it("should say nothing about a redirect written in a route handler", () => {
      const context = project({
        "app/api/a/route.ts":
          "export function GET() { return new Response(null, { status: 307 }); }",
      });
      expect(strictVerdict("functions/redirect", context)?.matched).toBe(false);
    });

    it("should report the interrupt a project adopted one half of", () => {
      const context = project({
        "app/page.tsx": [
          "import { unauthorized } from 'next/navigation';",
          "export default function P() { unauthorized(); }",
        ].join("\n"),
      });
      expect(strictVerdict("functions/forbidden", context)?.matched).toBe(true);
      expect(strictVerdict("functions/unauthorized", context)?.matched).toBe(false);
    });

    it("should say nothing where both halves are adopted", () => {
      const context = project({
        "app/page.tsx": [
          "import { forbidden, unauthorized } from 'next/navigation';",
          "export default function P() { forbidden(); unauthorized(); }",
        ].join("\n"),
      });
      for (const id of ["functions/forbidden", "functions/unauthorized"]) {
        expect(strictVerdict(id, context)?.matched).toBe(false);
      }
    });

    it("should say nothing where neither half is adopted", () => {
      const context = project({ "app/page.tsx": "export default function P() { return null; }" });
      for (const id of ["functions/forbidden", "functions/unauthorized"]) {
        expect(strictVerdict(id, context)?.matched).toBe(false);
      }
    });
  });

  describe("the restatements", () => {
    const WITH_ROOT = {
      "app/layout.tsx": "export default function L({ children }) { return children; }",
    };

    it("should report an API the project never reaches for, citing the root", () => {
      const verdict = strictVerdict("functions/cookies", project(WITH_ROOT));
      expect(verdict?.matched).toBe(true);
      expect(verdict?.evidence[0]).toContain("layout.tsx");
    });

    it("should say nothing where the project does reach for it", () => {
      const context = project({
        ...WITH_ROOT,
        "app/page.tsx": [
          "import { cookies } from 'next/headers';",
          "export default async function P() { return (await cookies()).get('a'); }",
        ].join("\n"),
      });
      expect(strictVerdict("functions/cookies", context)?.matched).toBe(false);
    });

    it("should say nothing where there is no root layout to cite", () => {
      expect(strictVerdict("functions/cookies", project({}))?.matched).toBe(false);
    });

    it("should mark every one of them, and mark nothing that cites a chain", () => {
      const marked = FUNCTION_PREDICATES.filter((entry) => entry.restatesUsed === true).map(
        (entry) => entry.id,
      );
      expect([...marked].sort()).toEqual([
        "functions/cookies",
        "functions/draft-mode",
        "functions/generate-image-metadata",
        "functions/generate-sitemaps",
        "functions/headers",
        "functions/image-response",
        "functions/use-link-status",
        "functions/use-offline",
        "functions/use-report-web-vitals",
      ]);
      // It reads a chain of files rather than an absence, which is what keeps it off the list.
      const params = FUNCTION_PREDICATES.find((entry) => entry.id === "functions/use-params");
      expect(params?.restatesUsed).toBeUndefined();
    });
  });

  it("should carry every conversion's objection on the predicate that replaced it", () => {
    const converted = FUNCTION_PREDICATES.filter((entry) => entry.reopenedFrom !== undefined);
    expect(converted.length).toBeGreaterThan(20);
    for (const entry of converted) {
      expect(entry.noSuggestion, entry.id).toBeUndefined();
      expect(entry.wouldApply, entry.id).toBeUndefined();
      expect(entry.reopenedFrom?.from, entry.id).toBe(entry.id);
      expect((entry.reopenedFrom?.why ?? "").length, entry.id).toBeGreaterThan(30);
    }
  });
});

describe("a route parameter threaded down, read off the binding", () => {
  const condition = (context: PredicateContext) => {
    const predicate = predicateFor("functions/use-params");
    const run = predicate.wouldApply ?? predicate.wouldApplyStrict;
    return run?.(context, surface("functions/use-params", "useParams"));
  };

  const ROUTE = [
    "import { Detalle } from './detalle';",
    "export default async function Page({ params }) {",
    "  const { id } = await params;",
    "  return <Detalle id={id} />;",
    "}",
  ].join("\n");

  /**
   * The shape reported on a real starter. `URLSearchParams` in a variable called `params` is
   * ordinary JavaScript, and the reading was written on the name: the chain
   * `page.tsx → usePosts.ts → postService.ts` was reported as a client component reading a route
   * parameter passed down to it.
   */
  it("should not follow a chain whose leaf builds a query string", () => {
    const context = project({
      "app/[id]/page.tsx": ROUTE,
      "app/[id]/detalle.tsx":
        "'use client';\nimport { buscar } from './servicio';\nexport function Detalle({ id }) { return buscar(id); }",
      "app/[id]/servicio.ts": [
        "export function buscar(query) {",
        "  const params = new URLSearchParams();",
        "  params.append('q', query);",
        "  return params.toString();",
        "}",
      ].join("\n"),
    });
    expect(condition(context)?.matched).toBe(false);
  });

  /** The corrected reading is not silence: a component actually given the params still reports. */
  it("should still follow a chain whose leaf is handed the route's own params", () => {
    const context = project({
      "app/[id]/page.tsx": ROUTE,
      "app/[id]/detalle.tsx":
        "'use client';\nimport { Ficha } from './ficha';\nexport function Detalle({ id }) { return <Ficha params={{ id }} />; }",
      "app/[id]/ficha.tsx":
        "'use client';\nexport function Ficha({ params }) { return params.id; }",
    });
    expect(condition(context)?.matched).toBe(true);
  });
});
