import type { SurfaceEntry } from "../collect/docs.js";
import type { ModuleGraph } from "../collect/graph.js";
import type { BuildOutput, RouteJoin } from "../collect/output.js";
import type { ProjectContext } from "../collect/project.js";
import type { RouteTree } from "../collect/routes.js";
import type { SourceIndex } from "../collect/sources.js";
import type { CostTier, Resolved } from "../types.js";

/** Everything a predicate is allowed to look at. Read-only by construction. */
export type PredicateContext = {
  readonly project: ProjectContext;
  readonly tree: RouteTree;
  /** Every source file, parsed once. Reading it makes a predicate `AST` tier. */
  readonly sources: SourceIndex;
  /**
   * How the files reference each other. Reading it makes a predicate `GRAFO` tier: the answer is
   * knowledge no single file carries.
   */
  readonly graph: ModuleGraph;
  /**
   * What the project's own production build recorded. Reading it makes a predicate `BUILD` tier.
   * Unresolved when there is no build to read, or when it predates the source: a predicate that
   * reads this must answer for that case, because assuming a default is the whole risk of the
   * tier.
   */
  readonly build: Resolved<BuildOutput>;
  /**
   * The build's own answer for each route, joined to the tree through its route mapping. Empty
   * when there is no build to read.
   *
   * Reading this to withdraw routes a predicate already selected does not make it `BUILD` tier:
   * an empty join withdraws nothing, so the predicate answers on a project with no build exactly
   * as it does today. A predicate that would *select* a route from here reads the build to reach
   * its answer, and declares the tier.
   */
  readonly join: RouteJoin;
  /** True only when the flag is known to be enabled. Unresolved must be false. */
  readonly isFlagEnabled: (flag: string) => boolean;
};

/**
 * A predicate's answer. Evidence is mandatory on a match: a verdict nobody can
 * check is worse than no verdict, so the catalog rejects one without paths.
 */
/** Carries `note`, `gain` and `reasons` as absent so a verdict's fields can be read without narrowing first. */
export type NoMatch = {
  readonly matched: false;
  readonly evidence: readonly string[];
  readonly note?: undefined;
  readonly gain?: undefined;
  readonly reasons?: undefined;
};

export type Match = {
  readonly matched: true;
  readonly evidence: readonly string[];
  /** One line explaining the condition, shown next to a would-apply entry. */
  readonly note?: string;
  /**
   * What the framework does once the API is adopted. The note says what was seen and what
   * follows from it; this says what changes with the API in place. Required on a suggestion and
   * meaningless on a used-detection match, which is why the two have different types below.
   */
  readonly gain?: string;
};

export type Verdict = NoMatch | Match;

/**
 * A would-apply verdict. A match here carries its gain: a condition that says what it saw and
 * not what adopting buys is half a recommendation, and the type makes the build fail until the
 * other half is authored rather than leaving it to a reader to notice the line missing.
 */
export type Suggestion =
  | NoMatch
  | (Match & { readonly gain: string; readonly reasons?: readonly Reason[] });

/**
 * One of several conditions a would-apply match was composed from: its sentence, what adopting buys,
 * and the files it cites. Carried beside the combined note and evidence, which join every reason
 * into one sentence over one list and so cannot say which file a sentence is about.
 */
export type Reason = {
  readonly note: string;
  readonly gain: string;
  readonly evidence: readonly string[];
};

export const NO_MATCH: NoMatch = { matched: false, evidence: [] };

export function match(evidence: readonly string[], note?: string): Match {
  return note === undefined ? { matched: true, evidence } : { matched: true, evidence, note };
}

/**
 * A would-apply match. The gain is authored beside the note because it belongs to the condition:
 * an entry holding two conditions holds two arguments, and each states its own.
 */
export function suggest(evidence: readonly string[], note: string, gain: string): Suggestion {
  return { matched: true, evidence, note, gain };
}

/**
 * A would-apply match composed from the conditions that fired. The combined sentence and list stay
 * what every consumer already reads; the reasons ride beside them only when there are two or more,
 * because one reason is the combined form already.
 */
export function suggestEach(reasons: readonly Reason[]): Suggestion {
  if (reasons.length === 0) return NO_MATCH;
  return {
    matched: true,
    evidence: [...new Set(reasons.flatMap((reason) => reason.evidence))].sort(),
    note: reasons.map((reason) => reason.note).join("; "),
    gain: reasons.map((reason) => reason.gain).join("; "),
    ...(reasons.length > 1 ? { reasons } : {}),
  };
}

/**
 * Predicates receive the surface entry so they can use its derived title as the symbol
 * to look for, instead of repeating it in an authored list.
 */
export type Predicate = (context: PredicateContext, surface: SurfaceEntry) => Verdict;

/** A would-apply predicate: the same inputs, and a verdict that carries its gain when it matches. */
export type SuggestionPredicate = (context: PredicateContext, surface: SurfaceEntry) => Suggestion;

/**
 * The hand-written half of a catalog entry. The other half — what exists — is derived
 * from the docs bundled with the installed Next.js, and is never written here.
 */
/**
 * Which preset a heuristic belongs to. `strict` is opt-in: it holds heuristics whose
 * condition is observed rather than proven, so they must not be the default experience.
 */
export type Preset = "default" | "strict";

/**
 * Why an entry never suggests. Required of a predicate set carrying no would-apply condition,
 * because an omission that says nothing cannot be told from an oversight — and the report prints
 * both as the same silence.
 *
 * Four kinds, because four different things are true of the entries that already exist:
 *
 * - `abstained` — a condition could be written and this project decided not to.
 * - `examined` — a `next.config` option that was looked at one at a time and yielded no condition.
 *   The condition tried and the outcome measured are separate fields rather than one sentence: a
 *   reason that only restates the option's purpose cannot be told from one recording an
 *   examination, and prose is the shape that lets the two look alike. `failed` names which of the
 *   two came back empty, because they are not the same answer: a condition that held everywhere
 *   argued nothing wherever it is measured, and stays examined; a condition that held nowhere
 *   found no project, which is the corpus's silence written in the entry's slot and converts to a
 *   condition pinned to a vendored case.
 * - `delegated` — the suggestion exists, on another entry. `middleware` delegates to `proxy`,
 *   which already warns when the deprecated file coexists with it.
 * - `unwritten` — a condition is believed to exist and nobody has written it. The only kind that
 *   is a backlog, which is the reason it gets a word of its own.
 *
 * The first three name the release whose documentation they were read against. `unwritten` does not,
 * and the omission is the point: it records that nobody has written a condition, which is true of
 * every release at once and so makes no claim one could date.
 */
/**
 * The Next.js release whose bundled documentation an examination read.
 *
 * A version rather than a date, because the verdict is a claim about what a page states and the
 * page ships with the package. Two examinations a month apart against the same release are equally
 * current; two on the same afternoon against different releases are not.
 *
 * Advancing it without re-opening the page the verdict is about is authoring a verdict nobody
 * measured, which is the one thing that would make the field a lie.
 */
export type MeasuredAgainst = string;

export type NoSuggestion =
  | { readonly kind: "abstained"; readonly why: string; readonly measuredAgainst: MeasuredAgainst }
  | {
      readonly kind: "examined";
      readonly measuredAgainst: MeasuredAgainst;
      /**
       * Which of the two came back empty. `condition` is about the entry and stays; `corpus` is
       * about the projects that were to hand, and catalog assembly refuses it — the field exists
       * so a survey has somewhere to write its answer before the entry converts.
       */
      readonly failed: "condition" | "corpus";
      readonly condition: string;
      readonly outcome: string;
    }
  | {
      readonly kind: "delegated";
      readonly to: string;
      readonly measuredAgainst: MeasuredAgainst;
    }
  | { readonly kind: "unwritten"; readonly why: string };

/**
 * The one place a refusal becomes a sentence. Composed rather than authored so every examined
 * option reads the same way, and so the fields cannot drift from the prose describing them.
 *
 * The release is named because a refusal is a claim about what a documented page states, and a
 * reader weighing one is owed which release it was read against. A verdict with no release to name
 * is the unwritten kind, which claims nothing about any of them.
 */
export function reasonFor(silence: NoSuggestion): string | undefined {
  if (silence.kind === "delegated") return undefined;
  if (silence.kind === "unwritten") return silence.why;
  const against = ` (read against Next.js ${silence.measuredAgainst})`;
  return silence.kind === "examined"
    ? `measured: ${silence.condition}, and ${silence.outcome}${against}`
    : `${silence.why}${against}`;
}

/**
 * The verdict a condition replaced, carried verbatim onto the predicate that replaced it.
 *
 * A reopened condition argues from a shape somebody measured as not arguing, so the measurement
 * travels with it rather than being deleted by the conversion. It is what withholds the condition
 * to the strict preset, and it is what a promotion has to answer: the objection is a written claim,
 * and evidence either answers it or restates it.
 *
 * Two shapes, because two kinds of verdict were reopened and they do not read alike. A refusal
 * recorded a condition and an outcome as separate facts, and both travel. An abstention recorded
 * one sentence saying the question is not about code, and it travels by reference — the id whose
 * map holds it — so that a family converting two dozen at once moves nothing and paraphrases
 * nothing. A reader is told which of the two they are looking at, because "somebody measured this
 * and it came back empty" and "somebody decided this is not a question about code" are different
 * grounds for withholding a finding.
 */
export type ReopenedFrom =
  | {
      /** The condition the examination tried, in the words it recorded. */
      readonly condition: string;
      /** What the measurement of it produced, in the words it recorded. */
      readonly outcome: string;
      readonly from?: undefined;
      readonly why?: undefined;
    }
  | {
      /**
       * The entry whose abstention is the objection. An id rather than the sentence, because the
       * sentence stays in the map its domain already keeps it in: a family converting two dozen of
       * these at once is two dozen chances to paraphrase, and the field promises verbatim.
       */
      readonly from: string;
      /** The abstention, read out of that map rather than retyped beside the predicate. */
      readonly why: string;
      readonly condition?: undefined;
      readonly outcome?: undefined;
    };

type PredicateSetBase = {
  /** Must equal a derived surface id, such as `file-conventions/layout`. */
  readonly id: string;
  /**
   * What the used-detection predicate reads, which is the entry's floor rather than its ceiling.
   *
   * `detectUsed` runs on every entry of every run and a strict-preset condition runs only where the
   * preset asks for it, so this is the reading a project pays for unconditionally — the number a
   * reader budgeting a run is asking about. A set that named itself by its most expensive predicate
   * would tell somebody running the default preset something false about what their run costs.
   */
  readonly cost: CostTier;
  /**
   * What this set's condition reads, where that differs from the used detection. Absent means the
   * two read the same thing, which is true of all but a handful of sets.
   *
   * It exists because one field could not hold two answers, and the field was believed for both: an
   * entry whose used detection reads one config key and whose condition reads a build had to pick,
   * and picking the condition's tier withdrew a verdict the entry could give without a build.
   * Assembly refuses one on a set that carries no condition.
   */
  readonly conditionCost?: CostTier;
  /**
   * Which of two conditions performs the reading `conditionCost` names, where a set carries a
   * default-preset condition and a strict one that read different things.
   *
   * One field cannot hold two tiers, so `conditionCost` holds the dearer of the two and this says
   * where it comes from. Without it the tier reads as a claim about both, and anything deciding
   * what a default run may perform would refuse the set for a reading its default-preset condition
   * never makes. Absent means the set carries one condition, or two that read the same thing.
   */
  readonly conditionCostReadBy?: "default" | "strict";
  /**
   * Set where the condition reads the module graph only to remove files a single read already
   * selected — the client side of the boundary, a file nothing the framework loads reaches — and
   * never to select one.
   *
   * The graph joins files rather than symbols, so a barrel over-reaches, and that is why a finding
   * resting on the graph waits behind `--strict`. A reading that only removes cannot rest a finding
   * on it: over-reach keeps a file one read had already kept, and a specifier resolving nowhere drops
   * one, so the worst either does is the answer without the graph, or silence. Assembly lets such a
   * condition run under the default preset; on a strict-only condition the mark changes nothing
   * there, and states the same fact. Either way `graph-reading.test.ts` holds the claim against every
   * fixture rather than taking it from this field.
   */
  readonly conditionCostNarrows?: true;
  /** Config flag this API needs. Absent means it always applies. */
  readonly requiredFlag?: string;
  readonly detectUsed: Predicate;
  readonly notApplicable?: Predicate;
  /**
   * Present where this set's condition replaced a refusal. Absent on a condition nobody refused
   * first, which is every condition written before the reversal.
   */
  readonly reopenedFrom?: ReopenedFrom;
  /**
   * Present where the condition's whole content is that the project does not use the API — the
   * Used bucket read backwards and printed as a finding.
   *
   * Marked rather than refused, because the decision to write these was taken deliberately and the
   * mark is what makes it reviewable: the report discloses how many of the strict preset are these,
   * so a reader who finds the preset useless learns why in one line instead of by reading every
   * entry. Nothing marked can be promoted — no evidence can answer an objection of that shape,
   * since every project the condition fires on is an instance of it — and assembly holds that.
   */
  readonly restatesUsed?: true;
};

/**
 * A set that argues for its API. The condition itself is the explanation, so no reason is asked
 * for. Either condition alone counts: an entry can hold only the opt-in one.
 */
type Suggests = SuggestsProven | SuggestsObservedOnly;

type SuggestsObservedOnly = {
  readonly wouldApply?: never;
  readonly wouldApplyPreset?: never;
  readonly wouldApplyStrict: SuggestionPredicate;
  readonly noSuggestion?: never;
};

type SuggestsProven = {
  readonly wouldApply: SuggestionPredicate;
  /** Marks the whole heuristic as opt-in. Absent means it runs in the default preset. */
  readonly wouldApplyPreset?: "strict";
  /**
   * An opt-in second argument for the same entry, evaluated only when `wouldApply` does not hold.
   * It exists because an entry can carry one condition that is proven and another that is merely
   * observed: marking the set opt-in would withhold the proven one, and leaving both in the default
   * preset would ship the observed one. Incoherent alongside `wouldApplyPreset`, which already
   * withholds everything.
   */
  readonly wouldApplyStrict?: SuggestionPredicate;
  readonly noSuggestion?: never;
};

/** A set that never argues, and says why. The reason is not optional: silence has to be a choice. */
type Silent = {
  readonly wouldApply?: never;
  readonly wouldApplyPreset?: never;
  readonly wouldApplyStrict?: never;
  readonly noSuggestion: NoSuggestion;
};

export type PredicateSet = PredicateSetBase & (Suggests | Silent);

export type CatalogEntry = {
  readonly surface: SurfaceEntry;
  readonly predicates: PredicateSet;
};

export type Catalog = {
  readonly entries: readonly CatalogEntry[];
  /** Derived surface this tool has no predicate for: our coverage gap, not the project's. */
  readonly documentedNotCovered: readonly SurfaceEntry[];
  /**
   * Derived surface that documents no adoptable API, so no predicate will ever answer for it.
   * Kept apart from the gap above and reported on its own: excluding it silently would shrink
   * the coverage figure without saying why.
   */
  readonly documentedNotAdoptable: readonly SurfaceEntry[];
  /** Predicates whose API does not exist in the installed version, so they are inert. */
  readonly predicatesWithoutSurface: readonly string[];
};
