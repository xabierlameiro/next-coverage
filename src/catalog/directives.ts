import type { SurfaceEntry } from "../collect/docs.js";
import {
  filesImporting,
  hasDirective,
  productionFiles,
  type SourceFileRecord,
} from "../collect/sources.js";
import { PLAIN_FETCH_NOTE, plainServerFetches } from "./functions.js";
import type {
  NoSuggestion,
  PredicateContext,
  PredicateSet,
  Reason,
  Suggestion,
  SuggestionPredicate,
  Verdict,
} from "./types.js";
import { match, NO_MATCH, suggest, suggestEach } from "./types.js";

/** Doc page id to the literal directive string Next.js looks for. */
const DIRECTIVE_TEXT: Readonly<Record<string, string>> = {
  "directives/use-client": "use client",
  "directives/use-server": "use server",
  "directives/use-cache": "use cache",
  "directives/use-cache-private": "use cache: private",
  "directives/use-cache-remote": "use cache: remote",
};

function detectUsed(context: PredicateContext, surface: SurfaceEntry): Verdict {
  const directive = DIRECTIVE_TEXT[surface.id];
  if (!directive) return NO_MATCH;
  const files = context.sources.files.filter((file) => hasDirective(file, directive));
  return files.length === 0 ? NO_MATCH : match(files.map((file) => file.path));
}

/**
 * Why the directives that never suggest never suggest. Which side of the boundary a module belongs
 * on is a design a project chose, and arguing a file onto the other side is not something a codebase
 * can evidence. The client directive keeps that silence and narrows it: whether a file shows any of
 * the documented reasons for the side it chose is read, and reported beside the entry under the
 * strict preset. The two cache scopes are different again: a scope is arguable from what the cached
 * function reads, and the argument simply has not been written.
 */
const NO_SUGGESTION: Readonly<Record<string, NoSuggestion>> = {
  "directives/use-client": {
    kind: "abstained",
    measuredAgainst: "16.3.0",
    why: "which side of the boundary a module belongs on is a design decision; whether a file shows a documented reason for the side it chose is what the strict preset reads and reports beside this entry",
  },
  "directives/use-server": {
    kind: "abstained",
    measuredAgainst: "16.3.0",
    why: "which side of the boundary a module belongs on is a design decision, not a finding",
  },
  "directives/use-cache-remote": {
    kind: "abstained",
    measuredAgainst: "16.3.0",
    why: "whether a cache is shared across deployments is an infrastructure choice, not a property of the code",
  },
};

/**
 * Two shapes argue for the cache directive, and a match carries one sentence, so the sentence is
 * composed from the shapes that fired rather than authored once per combination. When both fire,
 * each also travels as a reason with its own files: the joined sentence over one merged list left a
 * reader unable to tell a deprecated import from an unstated fetch.
 *
 * The deprecated predecessor is one: a project importing `unstable_cache` has a gap its own
 * documentation names. A plain server fetch is the other, and only under `cacheComponents` — the
 * extended `fetch` carries that shape without the flag, so a project is never shown both.
 */
function argumentsForTheCacheDirective(context: PredicateContext): Suggestion {
  const parts: Reason[] = [];

  const legacy = filesImporting(context.sources, "next/cache", "unstable_cache");
  if (legacy.length > 0) {
    parts.push({
      evidence: legacy.map((file) => file.path),
      note: "unstable_cache is deprecated in favour of the cache directive",
      gain: "the directive caches the function's result under cacheComponents, with cacheLife and cacheTag to set its lifetime and invalidate it",
    });
  }

  if (context.isFlagEnabled("cacheComponents")) {
    const plain = plainServerFetches(context);
    if (plain.length > 0) {
      parts.push({
        evidence: plain.map((file) => file.path),
        note: PLAIN_FETCH_NOTE,
        gain: "a cache scope around the call caches what it returns, with cacheLife and cacheTag to set how long that stays fresh and to drop it",
      });
    }
  }

  return suggestEach(parts);
}

/** The request APIs a cached scope cannot read without the private variant. */
const REQUEST_APIS = ["cookies", "headers", "draftMode"] as const;

/** The scope directives the private variant is the answer for. It is not one of them: it is. */
const CACHEABLE_SCOPE_DIRECTIVES = new Set(["use cache", "use cache: remote"]);

/** The local names a file binds to the request APIs, whatever it calls them. */
function requestApiLocalsOf(file: SourceFileRecord): string[] {
  const bindings = file.imports.get("next/headers") ?? [];
  return bindings
    .filter((binding) => !binding.typeOnly && REQUEST_APIS.some((api) => api === binding.imported))
    .map((binding) => binding.local);
}

/**
 * A cache scope reading what identifies the request. The private variant is documented as the one
 * that lets a cached function reach `cookies`, `headers` and `searchParams` — a scope keyed on
 * nothing that identifies the request while reading data that does is what it exists for, and the
 * argument is the call, in the scope.
 *
 * In the scope, not in the file. A file may cache one function and read the request in another, and
 * the two have nothing to do with each other; reporting that file states something false about the
 * function it names. So the directive and the call must belong to the same body, and a scope already
 * carrying the private variant is not the shape either: it is the answer.
 */
function cacheScopeReadingTheRequest(context: PredicateContext): Suggestion {
  const files = productionFiles(context.sources).filter((file) => {
    const locals = requestApiLocalsOf(file);
    if (locals.length === 0) return false;
    return file.cacheScopes.some(
      (scope) =>
        CACHEABLE_SCOPE_DIRECTIVES.has(scope.directive) &&
        locals.some((local) => scope.calledIdentifiers.has(local)),
    );
  });
  return files.length === 0
    ? NO_MATCH
    : suggest(
        files.map((file) => file.path),
        "these cache scopes read what identifies the request while being keyed on nothing that does",
        "the private variant lets the scope reach cookies, headers and searchParams, and keeps what it returns off the server between requests",
      );
}

/**
 * The flag each directive waits on. Both cache scopes are inert without Cache Components, so an
 * entry gated here reports the flag rather than a verdict — the reader is told what to turn on,
 * not that the API was not evaluated.
 */
const REQUIRED_FLAG: Readonly<Record<string, string>> = {
  "directives/use-cache": "cacheComponents",
  "directives/use-cache-private": "cacheComponents",
};

const WOULD_APPLY: Readonly<Record<string, SuggestionPredicate>> = {
  "directives/use-cache": argumentsForTheCacheDirective,
  "directives/use-cache-private": cacheScopeReadingTheRequest,
};

export const DIRECTIVE_PREDICATES: readonly PredicateSet[] = Object.keys(DIRECTIVE_TEXT).map(
  (id): PredicateSet => {
    const requiredFlag = REQUIRED_FLAG[id];
    const gate = requiredFlag === undefined ? {} : { requiredFlag };
    const wouldApply = WOULD_APPLY[id];
    // The plain-fetch half of the cache directive's argument reads the graph, and only to narrow.
    const tier =
      id === "directives/use-cache"
        ? { conditionCost: "GRAFO" as const, conditionCostNarrows: true as const }
        : {};
    if (wouldApply !== undefined) {
      return { id, cost: "AST", ...tier, ...gate, detectUsed, wouldApply };
    }

    const noSuggestion = NO_SUGGESTION[id];
    if (noSuggestion === undefined) throw new Error(`no reason authored for silent '${id}'`);
    return { id, cost: "AST", ...gate, detectUsed, noSuggestion };
  },
);
