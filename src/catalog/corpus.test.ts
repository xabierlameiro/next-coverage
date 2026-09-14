import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Vendored } from "../../test-support/corpus.js";
import {
  fileIn,
  fixtureContext,
  fixtureRoot,
  PINNED,
  VENDORED,
} from "../../test-support/corpus.js";
import {
  FIXTURES,
  fixtureAvailable,
  okAnalysis,
  realCodeAvailable,
} from "../../test-support/fixtures.js";
import type { SurfaceEntry } from "../collect/docs.js";
import { deriveSurface } from "../collect/docs.js";
import { discoverProject } from "../collect/project.js";
import { ALL_PREDICATES } from "./build.js";
import { configOptionPredicate } from "./config.js";
import type { Predicate, PredicateSet } from "./types.js";
import { NO_MATCH } from "./types.js";

/**
 * The would-apply conditions, each with the fixture built to trigger it and the file the verdict
 * cites. Asserting per condition rather than counting how many fire: a total passes while the wrong
 * ones fire, and the evidence check is what pins each case to the file that exists for it.
 */
const CASES: readonly {
  readonly id: string;
  readonly fixture: Vendored;
  readonly evidence: string;
  readonly strict?: true;
  /**
   * The sentence the condition states, where the figure inside it is the thing that can be wrong.
   * Most cases do not need this: asserting that a condition fires and cites the right file is what
   * proves it works. It is written where a reading could count the wrong things and still fire —
   * the sitemap condition counted route handlers as pages for as long as nothing asserted the
   * number it printed.
   */
  readonly saying?: string;
}[] = [
  {
    id: "components/image",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "galeria", "page.tsx"),
  },
  {
    id: "components/link",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "navegacion", "page.tsx"),
  },
  {
    id: "components/script",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "analitica", "page.tsx"),
  },
  {
    id: "components/font",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "tipografia", "page.tsx"),
  },
  {
    id: "config/next-config-js/reactCompiler",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "memo", "page.tsx"),
  },
  {
    id: "config/next-config-js/typedRoutes",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "navegacion", "page.tsx"),
  },
  {
    id: "config/next-config-js/urlImports",
    fixture: "unflagged-app",
    evidence: fileIn("unflagged-app", "app", "remoto", "page.tsx"),
  },
  {
    id: "functions/cacheLife",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "cacheado", "page.tsx"),
  },
  {
    id: "functions/cacheTag",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "cacheado", "page.tsx"),
  },
  {
    id: "functions/generate-static-params",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "articulo", "[slug]", "page.tsx"),
  },
  {
    id: "file-conventions/loading",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "lenta", "page.tsx"),
  },
  {
    id: "file-conventions/error",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "fallo", "error.tsx"),
  },
  {
    id: "file-conventions/not-found",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "ausente", "page.tsx"),
  },
  {
    id: "file-conventions/template",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "Template.tsx"),
  },
  {
    id: "file-conventions/default",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "panel", "@lateral"),
  },
  {
    id: "directives/use-cache",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "heredado", "page.tsx"),
  },
  // The other half of the flag split. `overconfigured-app` leaves `cacheComponents` unset, so the
  // extended `fetch` is the entry the shape is handed to; the same page under the flag is carried
  // by the cache directive, and `directives.test.ts` holds both sides against each other.
  {
    id: "functions/fetch",
    fixture: "overconfigured-app",
    evidence: fileIn("overconfigured-app", "app", "datos", "page.tsx"),
  },
  {
    id: "directives/use-cache-private",
    fixture: "unflagged-app",
    evidence: fileIn("unflagged-app", "app", "preferencias", "page.tsx"),
  },
  {
    id: "functions/generate-metadata",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "articulo", "[slug]", "page.tsx"),
  },
  {
    id: "functions/generate-viewport",
    fixture: "sparse-app",
    evidence: fileIn("sparse-app", "app", "ajustes", "page.tsx"),
  },
  {
    id: "components/form",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "busqueda", "page.tsx"),
  },
  {
    id: "file-conventions/metadata/opengraph-image",
    fixture: "sparse-app",
    evidence: fileIn("sparse-app", "app", "prensa", "page.tsx"),
  },
  {
    id: "file-conventions/proxy",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "middleware.ts"),
  },
  {
    // The figure is asserted, not just the firing. `app/api/salud/route.ts` serves a URL this
    // number must not include, and before it was counted here the condition reported route
    // handlers as pages with nothing to catch it.
    id: "file-conventions/metadata/sitemap",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app"),
    saying: "the project serves 17 pages and declares no sitemap",
  },
  {
    id: "file-conventions/metadata/manifest",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "apple-icon.tsx"),
  },
  // The fixture enables cacheComponents, so `io` is the replacement its documentation prefers.
  {
    id: "functions/io",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "sin-cache", "page.tsx"),
  },
  {
    id: "functions/revalidateTag",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "acciones", "actions.ts"),
    strict: true,
  },
  {
    id: "file-conventions/intercepting-routes",
    fixture: "incomplete-app",
    // The evidence is the segment directory, as it is for a slot with no default.
    evidence: fileIn("incomplete-app", "app", "catalogo", "[id]"),
    strict: true,
  },
  {
    id: "file-conventions/mdx-components",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "package.json"),
  },
  {
    id: "file-conventions/instrumentation",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "package.json"),
    strict: true,
  },
  {
    id: "file-conventions/instrumentation-client",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "package.json"),
    strict: true,
  },
  {
    id: "file-conventions/route-groups",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "galeria"),
    strict: true,
  },
  {
    // The same file backs `components/image`: a raw img is both an unadopted Image component and
    // an absolute asset path. It silences neither case, but an edit to it now breaks two.
    id: "file-conventions/public-folder",
    fixture: "incomplete-app",
    evidence: fileIn("incomplete-app", "app", "galeria", "page.tsx"),
    strict: true,
  },
  // Below: the cases incomplete-app cannot hold, because each needs a whole-project property that
  // contradicts one its own cases depend on. See sparse-app's README.
  {
    id: "file-conventions/metadata/robots",
    fixture: "sparse-app",
    evidence: fileIn("sparse-app", "app", "sitemap.ts"),
  },
  {
    id: "functions/connection",
    fixture: "sparse-app",
    evidence: fileIn("sparse-app", "app", "informe", "page.tsx"),
  },
  {
    id: "file-conventions/parallel-routes",
    fixture: "sparse-app",
    evidence: fileIn("sparse-app", "app", "panel"),
    strict: true,
  },
  {
    // The second condition on this entry. Its first, `casingNearMiss`, has its own case above
    // against incomplete-app, and is what makes this one unreachable there.
    id: "file-conventions/template",
    fixture: "sparse-app",
    evidence: fileIn("sparse-app", "app", "ajustes"),
    strict: true,
  },
  {
    // The same client layout the template case argues from, reached by the other question it
    // raises: it reads the pathname, and it is a layout. The evidence is a chain rather than a
    // path, relativised by the condition for the reason the notFound one is.
    id: "functions/use-selected-layout-segment",
    fixture: "sparse-app",
    evidence: join("app", "ajustes", "layout.tsx"),
    strict: true,
  },
  {
    // The switches-off cases. Both argue from code the configuration leaves inert, and neither
    // can live in the other two vendored projects: those set the flags these argue from.
    id: "config/next-config-js/authInterrupts",
    fixture: "unflagged-app",
    evidence: fileIn("unflagged-app", "app", "forbidden.tsx"),
  },
  {
    id: "config/next-config-js/useOffline",
    fixture: "unflagged-app",
    evidence: fileIn("unflagged-app", "app", "sincronizacion", "estado-red.tsx"),
  },
  {
    // The one page in this family whose predicate is derived rather than authored, and the only
    // shape of the family a vendored project already holds: `overconfigured-app` sets
    // `cacheHandlers` and sets no `cacheHandler`. It was not edited to make this fire — that
    // fixture exists to set the options nothing else in the corpus sets, and the pair is a
    // consequence of that rather than of this case.
    id: "config/next-config-js/incrementalCacheHandlerPath",
    fixture: "overconfigured-app",
    evidence: fileIn("overconfigured-app", "next.config.ts"),
    strict: true,
  },
  {
    // The manifest trap. It names two sources: one served from public/, one provided by nothing.
    // A condition resolving against the conventions alone reports the first, which is correct —
    // that false positive is what refused this condition the first time it was measured.
    id: "file-conventions/metadata/app-icons",
    fixture: "unflagged-app",
    evidence: fileIn("unflagged-app", "app", "manifest.ts"),
  },
  // Its own project, because `overconfigured-app` is pinned to the opposite case: the same page
  // argues there that a project without a handler could adopt one, and giving that fixture a
  // handler silences it. Two conditions wanting opposite properties is a reason to add a project.
  {
    id: "config/next-config-js/cacheMaxMemorySize",
    fixture: "handler-cache-app",
    evidence: fileIn("handler-cache-app", "next.config.ts"),
  },
];

function predicateFor(id: string): PredicateSet {
  const found = ALL_PREDICATES.find((predicate) => predicate.id === id);
  // A page whose name is not its key is answered by the derived predicate, and one of those now
  // carries a condition. Looked for here rather than authored into the list above, which is the
  // whole point of attaching the verdict to the derivation.
  const derived = found ?? configOptionPredicate(surfaceOf(id));
  if (derived === undefined) throw new Error(`no predicate for ${id}`);
  return derived;
}

/** The surface entry a predicate receives. Only its id and title are read by one. */
function surfaceOf(id: string): SurfaceEntry {
  return {
    id,
    domain: "file-conventions",
    title: id.split("/").at(-1) ?? "",
    relatedLinks: [],
    docPath: `/docs/${id}.md`,
    frontmatterFailed: false,
    docRelativePath: "",
    docUrl: "",
    adoptable: true,
  };
}

/** Under the strict preset both conditions run; under the default only the proven one does. */
function conditionOf(predicates: PredicateSet, strict: boolean): Predicate {
  const admitted = predicates.wouldApplyPreset !== "strict" || strict;
  return (context, surface) => {
    if (predicates.wouldApply !== undefined && admitted) {
      const proven = predicates.wouldApply(context, surface);
      if (proven.matched) return proven;
    }
    if (predicates.wouldApplyStrict !== undefined && strict) {
      return predicates.wouldApplyStrict(context, surface);
    }
    return { matched: false, evidence: [] };
  };
}

describe("every authored condition fires against a project built to trigger it", () => {
  for (const { id, fixture, evidence, strict, saying } of CASES) {
    it(`${id} fires on ${fixture}${strict ? " under --strict" : ""}`, () => {
      const verdict = conditionOf(predicateFor(id), strict === true)(
        fixtureContext(fixture),
        surfaceOf(id),
      );
      expect(verdict.matched).toBe(true);
      expect(verdict.evidence).toContain(evidence);
      if (saying !== undefined) expect(verdict.note).toBe(saying);
    });
  }

  /**
   * One fact, one suggestion. A reader counting suggestions is counting facts about the project,
   * and four entries reporting one sentence over one set of files is one fact presented as four.
   *
   * Measured across both presets because the duplication crossed them: on the primary fixture the
   * invalidation family reported the same thirty files four times as partial adoption, where the
   * would-apply bucket showed nothing at all.
   */
  describe.skipIf(!realCodeAvailable())("no project reports one fact twice", () => {
    for (const fixture of FIXTURES) {
      for (const preset of ["default", "strict"] as const) {
        it.skipIf(!fixtureAvailable(fixture))(`${fixture.name} under ${preset}`, () => {
          const analysis = okAnalysis(fixture, preset);
          const byFact = new Map<string, string[]>();
          for (const entry of analysis.result.entries) {
            const claims = [
              entry.bucket === "would-apply"
                ? { note: entry.note, evidence: entry.evidence }
                : undefined,
              entry.alsoWouldApply,
            ].filter((claim) => claim !== undefined);
            for (const claim of claims) {
              const key = `${claim.note ?? ""}||${[...claim.evidence].sort().join(",")}`;
              const seen = byFact.get(key);
              if (seen === undefined) byFact.set(key, [entry.id]);
              else seen.push(entry.id);
            }
          }
          const repeated = [...byFact.values()]
            .filter((ids) => ids.length > 1)
            .map((ids) => ids.join(" + "));
          expect(repeated).toEqual([]);
        });
      }
    }
  });

  describe.skipIf(!realCodeAvailable())("how far the build contrast reaches", () => {
    /**
     * The claim that keeps the register honest. A disagreement appearing is a finding about the
     * corpus, and it must not arrive while a line here still says none has been seen.
     */
    it("sees no contrast disagreement on any referenced project", () => {
      const disagreeing = FIXTURES.filter(fixtureAvailable)
        .map((fixture) => ({ fixture, result: okAnalysis(fixture).result }))
        .filter((row) => row.result.contrast.findings.length > 0)
        .map((row) => `${row.fixture.name}: ${row.result.contrast.findings.length}`);
      expect(disagreeing).toEqual([]);
    });
  });

  /**
   * The convention is reported as used rather than as a condition that fires, so it has no row among
   * the cases above. It is asserted here because the reading it rests on was wrong: a fixed list of
   * four names, which a project holding `proxy.tsx` did not match. Reverting `proxyFiles` to that
   * list fails this.
   */
  /**
   * Two readings of one convention, and both were wrong. The entry carried no predicate at all, so a
   * project adopting the convention received no verdict in any bucket; and root coverage for an
   * uncaught `notFound()` call read only the `not-found` name, so the same project was told its call
   * landed on the built-in page while a `global-not-found` file sat in its app directory.
   */
  describe("the global-not-found convention", () => {
    it("is reported as used where the flag is on, citing the file", () => {
      const context = fixtureContext("global-not-found-app");
      const verdict = predicateFor("file-conventions/global-not-found").detectUsed(
        context,
        surfaceOf("file-conventions/global-not-found"),
      );
      expect(verdict.matched).toBe(true);
      expect(verdict.evidence).toContain(
        fileIn("global-not-found-app", "app", "global-not-found.tsx"),
      );
    });

    it("is not reported as used where the flag is off, though the file is on disk", () => {
      const context = fixtureContext("unflagged-app");
      const verdict = predicateFor("file-conventions/global-not-found").detectUsed(
        context,
        surfaceOf("file-conventions/global-not-found"),
      );
      expect(verdict.matched).toBe(false);
    });

    it("catches an uncaught notFound() call, so the not-found entry argues for nothing", () => {
      const context = fixtureContext("global-not-found-app");
      const verdict = conditionOf(predicateFor("file-conventions/not-found"), false)(
        context,
        surfaceOf("file-conventions/not-found"),
      );
      expect(verdict.matched).toBe(false);
    });
  });

  /**
   * The exemption is per rule and per line, and the fixture holds all three answers: a file-wide
   * disable, a line-scoped one, and a raw `img` beside the line-scoped one that nothing exempts.
   * Removing the filter in `imageWouldApply` fails this by naming the two exempted files.
   */
  describe("a raw img the project exempted on purpose", () => {
    const evidenceForImage = () => {
      const verdict = conditionOf(predicateFor("components/image"), false)(
        fixtureContext("incomplete-app"),
        surfaceOf("components/image"),
      );
      return verdict.evidence;
    };

    it("names neither the file-wide nor the line-scoped exemption", () => {
      const evidence = evidenceForImage();
      expect(evidence).not.toContain(fileIn("incomplete-app", "app", "editor", "NodoImagen.tsx"));
    });

    it("still names a file whose raw img nothing exempts", () => {
      const evidence = evidenceForImage();
      expect(evidence).toContain(fileIn("incomplete-app", "app", "galeria", "page.tsx"));
      // `subida/Vista.tsx` holds one exempted img and one that is not, so the file stays named.
      expect(evidence).toContain(fileIn("incomplete-app", "app", "subida", "Vista.tsx"));
    });
  });

  describe("a proxy under an extension the old reading did not name", () => {
    it("is reported as used, citing the file", () => {
      const context = fixtureContext("sparse-app");
      const verdict = predicateFor("file-conventions/proxy").detectUsed(
        context,
        surfaceOf("file-conventions/proxy"),
      );
      expect(verdict.matched).toBe(true);
      expect(verdict.evidence).toContain(fileIn("sparse-app", "proxy.tsx"));
    });
  });

  describe("each fixture still holds the whole-project properties its cases depend on", () => {
    for (const fixture of VENDORED) {
      for (const property of PINNED[fixture]) {
        it(`${fixture}: ${property.describe}`, () => {
          expect(property.holds(fixtureRoot(fixture))).toBe(true);
        });
      }
    }
  });

  /**
   * The conditions written in place of a reason that argued from the corpus rather than from code.
   * Each one is a promise the register has to keep: the state the reason used to hold — *no project
   * of that shape* — moves here, where it is measured against the projects it is about, or the
   * condition is shown firing on one of them and the state was never true.
   *
   * Held apart from `CASES` and `SILENT` because it asks a third question. `CASES` says a vendored
   * project can fire it; `SILENT` says whether anybody's own code does; this says the entry stopped
   * answering that second question in its own slot.
   */
  const CONVERTED: readonly string[] = [
    "components/form",
    "file-conventions/metadata/opengraph-image",
    "directives/use-cache-private",
    "functions/fetch",
    "functions/generate-metadata",
    "functions/generate-viewport",
  ];

  /**
   * Entries that point at a converted condition rather than carrying it. They are not in
   * `CONVERTED` — they carry nothing to register — and a version documenting the carrier without
   * them would leave the pointer dangling, so the version check reads both lists.
   */
  const DELEGATING: readonly string[] = ["functions/use-selected-layout-segments"];

  /**
   * A case proves a condition fires; it says nothing about whether the entry it fires for exists
   * on the versions the corpus holds. A condition pinned to a page a supported version does not
   * document would pass every case in this file and report nothing on half the corpus.
   *
   * Both versions in the corpus document all seven, so no case records an absence. The assertion is
   * here so the first one that does not is named rather than discovered later.
   */
  describe.skipIf(!realCodeAvailable())("every converted condition exists on both versions", () => {
    for (const fixture of FIXTURES) {
      it.skipIf(!fixtureAvailable(fixture))(
        `${fixture.name} documents them all on next ${fixture.next}`,
        () => {
          const discovery = discoverProject(fixture.path);
          if (discovery.kind !== "ok") throw new Error(`expected ${fixture.name} to discover`);
          const surface = deriveSurface(discovery.project.installedNext);
          if (surface.status !== "available") {
            throw new Error(`expected a surface for ${fixture.name}`);
          }
          const documented = new Set(surface.entries.map((entry) => entry.id));
          const absent = [...CONVERTED, ...DELEGATING].filter((id) => !documented.has(id));
          expect(absent).toEqual([]);
        },
      );
    }
  });

  /**
   * A reopened condition argues from a shape a measurement refused, so it ships behind `--strict`
   * and the refusal it carries is what withholds it. Leaving that preset is a claim: that a
   * referenced project's evidence answers the objection rather than being another instance of it.
   *
   * The register is what makes the claim reviewable. It is empty because nothing has been promoted
   * yet, and the assertion below is what stops the first promotion from happening quietly.
   */
  describe("a reopened condition that left the strict preset", () => {
    const PROMOTED_WITH_AN_ANSWER: readonly {
      readonly id: string;
      readonly project: string;
      readonly answer: string;
    }[] = [];

    const answered = new Set(PROMOTED_WITH_AN_ANSWER.map((row) => row.id));

    /** A reopened condition running in the default preset, whichever field carries it. */
    const promoted = (predicates: readonly PredicateSet[]) =>
      predicates.filter(
        (predicate) =>
          predicate.reopenedFrom !== undefined &&
          predicate.wouldApply !== undefined &&
          predicate.wouldApplyPreset !== "strict",
      );

    it("should register an answer for every reopened condition it promoted", () => {
      const unaccounted = promoted(ALL_PREDICATES)
        .map((predicate) => predicate.id)
        .filter((id) => !answered.has(id));
      expect(unaccounted).toEqual([]);
    });

    it("should fail on a promotion nobody recorded an answer for", () => {
      const invented: PredicateSet = {
        id: "config/next-config-js/taint",
        cost: "AST",
        detectUsed: () => NO_MATCH,
        wouldApply: () => NO_MATCH,
        reopenedFrom: { condition: "a shape somebody tried", outcome: "and it was refused" },
      };
      expect(promoted([invented]).map((p) => p.id)).toEqual(["config/next-config-js/taint"]);
      expect(answered.has(invented.id)).toBe(false);
    });

    it("should leave a reopened condition that stayed behind the flag alone", () => {
      const withheld: PredicateSet = {
        id: "config/next-config-js/taint",
        cost: "AST",
        detectUsed: () => NO_MATCH,
        wouldApplyStrict: () => NO_MATCH,
        reopenedFrom: { condition: "a shape somebody tried", outcome: "and it was refused" },
      };
      expect(promoted([withheld])).toEqual([]);
    });

    it("should say nothing about a default-preset condition that reopened nothing", () => {
      const plain: PredicateSet = {
        id: "file-conventions/page",
        cost: "AST",
        detectUsed: () => NO_MATCH,
        wouldApply: () => NO_MATCH,
      };
      expect(promoted([plain])).toEqual([]);
    });
  });
});
