import { describe, expect, it } from "vitest";
import { fileIn, fixtureContext, type Vendored } from "../../test-support/corpus.js";
import type { SurfaceEntry } from "../collect/docs.js";
import { DIRECTIVE_PREDICATES } from "./directives.js";
import { FUNCTION_PREDICATES, PLAIN_FETCH_NOTE } from "./functions.js";
import type { PredicateSet } from "./types.js";

function predicateFor(id: string): PredicateSet {
  const found = [...DIRECTIVE_PREDICATES, ...FUNCTION_PREDICATES].find(
    (predicate) => predicate.id === id,
  );
  if (!found) throw new Error(`no predicate for ${id}`);
  return found;
}

function surface(id: string, domain: SurfaceEntry["domain"], title: string): SurfaceEntry {
  return {
    id,
    domain,
    title,
    relatedLinks: [],
    docPath: `/docs/${id}.md`,
    frontmatterFailed: false,
    docRelativePath: "",
    docUrl: "",
    adoptable: true,
  };
}

const FETCH = surface("functions/fetch", "functions", "fetch");
const USE_CACHE_PRIVATE = surface(
  "directives/use-cache-private",
  "directives",
  "use cache: private",
);
const USE_CACHE = surface("directives/use-cache", "directives", "use cache");

const wouldApply = (id: string, fixture: Vendored, entry: SurfaceEntry) => {
  const predicate = predicateFor(id).wouldApply;
  if (!predicate) throw new Error(`${id} carries no would-apply condition`);
  return predicate(fixtureContext(fixture), entry);
};

/**
 * One shape, two entries, and the flag decides which one answers. The pair is asserted against
 * each other rather than one at a time: a condition that fires on both sides of the flag reads as
 * correct when either half is read alone, and reporting both is the failure the split exists to
 * prevent.
 */
describe("a plain server fetch, split by cacheComponents", () => {
  describe("without the flag", () => {
    it("should be carried by the extended fetch", () => {
      const verdict = wouldApply("functions/fetch", "overconfigured-app", FETCH);
      expect(verdict.matched).toBe(true);
      expect(verdict.evidence).toEqual([
        fileIn("overconfigured-app", "app", "datos", "page.tsx"),
        fileIn("overconfigured-app", "lib", "existencias.ts"),
      ]);
    });

    it("should leave the cache directive silent", () => {
      expect(wouldApply("directives/use-cache", "overconfigured-app", USE_CACHE).matched).toBe(
        false,
      );
    });
  });

  describe("with the flag", () => {
    it("should be carried by the cache directive", () => {
      const verdict = wouldApply("directives/use-cache", "unflagged-app", USE_CACHE);
      expect(verdict.matched).toBe(true);
      expect(verdict.evidence).toEqual([
        fileIn("unflagged-app", "app", "informes", "historico.ts"),
        fileIn("unflagged-app", "app", "informes", "page.tsx"),
      ]);
    });

    /**
     * Both reasons fire here, and the joined note over the merged list cannot say which file is the
     * deprecated import and which the unstated fetch. Each reason keeps its own.
     */
    it("should keep each reason's files apart when both fire", () => {
      const verdict = wouldApply("directives/use-cache", "unflagged-app", USE_CACHE);
      expect(verdict.reasons?.map((reason) => [reason.note, reason.evidence])).toEqual([
        [
          "unstable_cache is deprecated in favour of the cache directive",
          [fileIn("unflagged-app", "app", "informes", "historico.ts")],
        ],
        [PLAIN_FETCH_NOTE, [fileIn("unflagged-app", "app", "informes", "page.tsx")]],
      ]);
    });

    it("should leave the extended fetch silent", () => {
      expect(wouldApply("functions/fetch", "unflagged-app", FETCH).matched).toBe(false);
    });
  });

  /**
   * The calls that already say what they want. Kept in a file of their own so the evidence above
   * names one page: a file holding both shapes would be cited for the plain call and prove
   * nothing about the others.
   */
  it("should exclude a call stating its cache, its next option, or building its options elsewhere", () => {
    const verdict = wouldApply("functions/fetch", "overconfigured-app", FETCH);
    expect(verdict.evidence).not.toContain(
      fileIn("overconfigured-app", "app", "declarado", "page.tsx"),
    );
  });

  it("should follow the import from the page into the helper that makes the call", () => {
    const verdict = wouldApply("functions/fetch", "overconfigured-app", FETCH);
    expect(verdict.evidence).toContain(fileIn("overconfigured-app", "lib", "existencias.ts"));
    expect(verdict.evidence).not.toContain(
      fileIn("overconfigured-app", "app", "almacen", "page.tsx"),
    );
  });

  /**
   * Neither file shows a signal one read can see — no shebang, no `process.argv`, no client
   * directive — and both were cited as server-side calls on the primary fixture. What they share is
   * that nothing Next.js runs reaches them.
   */
  it("should exclude a Node script nothing the framework runs imports", () => {
    const verdict = wouldApply("functions/fetch", "overconfigured-app", FETCH);
    expect(verdict.evidence).not.toContain(
      fileIn("overconfigured-app", "scripts", "sincronizar.ts"),
    );
  });

  it("should exclude a browser bundle nothing the framework runs imports", () => {
    const verdict = wouldApply("functions/fetch", "overconfigured-app", FETCH);
    expect(verdict.evidence).not.toContain(
      fileIn("overconfigured-app", "docs", "manual", "soporte.js"),
    );
  });

  it("should exclude a call on the client side", () => {
    const verdict = wouldApply("functions/fetch", "overconfigured-app", FETCH);
    expect(verdict.evidence).not.toContain(
      fileIn("overconfigured-app", "app", "interactivo", "panel.tsx"),
    );
  });

  it("should say what adopting the entry that carries it buys", () => {
    const withoutFlag = wouldApply("functions/fetch", "overconfigured-app", FETCH);
    const withFlag = wouldApply("directives/use-cache", "unflagged-app", USE_CACHE);
    expect(withoutFlag.gain).toContain("next option");
    expect(withFlag.gain).toContain("cache scope");
  });
});

/**
 * The scope that reads what identifies the request. `unflagged-app` is the only vendored project
 * with `cacheComponents` on, which is what makes it the one that can hold this.
 */
describe("a cache scope reading per-request data", () => {
  it("should argue for the private variant, citing the file", () => {
    const verdict = wouldApply("directives/use-cache-private", "unflagged-app", USE_CACHE_PRIVATE);
    expect(verdict.matched).toBe(true);
    expect(verdict.evidence).toEqual([fileIn("unflagged-app", "app", "preferencias", "page.tsx")]);
  });

  it("should not cite a scope that already carries the private variant", () => {
    const verdict = wouldApply("directives/use-cache-private", "unflagged-app", USE_CACHE_PRIVATE);
    expect(verdict.evidence).not.toContain(fileIn("unflagged-app", "app", "privado", "page.tsx"));
  });

  /**
   * The directive and the read must belong to the same body. A file caching one function and
   * reading the request in another holds neither shape, and citing it states something false about
   * the scope it names.
   */
  it("should not cite a file whose cached scope reads nothing that identifies the request", () => {
    const verdict = wouldApply("directives/use-cache-private", "unflagged-app", USE_CACHE_PRIVATE);
    expect(verdict.evidence).not.toContain(fileIn("unflagged-app", "app", "mixto", "page.tsx"));
  });

  it("should say what the private variant buys", () => {
    const verdict = wouldApply("directives/use-cache-private", "unflagged-app", USE_CACHE_PRIVATE);
    expect(verdict.gain).toContain("cookies, headers and searchParams");
  });

  /**
   * The flag-off half, and where it is enforced. The condition itself never reads the flag: the
   * entry declares the flag it waits on, and classification reports that in place of a verdict —
   * the same gate `use-cache` and the auth interrupts already carry, tested against a project in
   * `classify.test.ts`. Asserted here as the declaration, because a condition that answered on a
   * project without Cache Components would be advising a directive that does nothing there.
   */
  it("should declare the flag it waits on rather than answering without it", () => {
    expect(predicateFor("directives/use-cache-private").requiredFlag).toBe("cacheComponents");
    expect(predicateFor("directives/use-cache").requiredFlag).toBe("cacheComponents");
  });
});

describe("the client directive's remaining silence", () => {
  const silence = predicateFor("directives/use-client").noSuggestion;

  it("should abstain about the side and name what the strict preset reads instead", () => {
    expect(silence?.kind).toBe("abstained");
    const why = silence?.kind === "abstained" ? silence.why : "";
    expect(why).toContain("design decision");
    expect(why).toContain("strict preset");
    // The question is decided under strict, so the abstention must not read as undecidable.
    expect(why).not.toContain("not a finding");
  });

  it("should keep the server directive's silence about the side alone", () => {
    const server = predicateFor("directives/use-server").noSuggestion;
    expect(server?.kind === "abstained" ? server.why : "").not.toContain("strict preset");
  });
});
