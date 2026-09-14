import type { SurfaceDerivation, SurfaceEntry } from "../collect/docs.js";
import {
  BorrowedReasonError,
  ConditionCostWithoutConditionError,
  CorpusExaminationError,
  CorpusVoiceError,
  DanglingDelegationError,
  DeprecatedOptionConditionError,
  DroppedRefusalError,
  DuplicatePredicateError,
  GraphTierUnderTheDefaultPresetError,
  NarrowingWithoutGraphTierError,
  PrematureBuildTierError,
  PromotedRestatementError,
  SilentPredicateError,
  UnattributedConditionCostError,
  UnexaminedRefusalError,
  UnpromotableConditionError,
  UnrecordedReopeningError,
  UsedDetectionBuildTierError,
} from "../errors.js";
import { COMPONENT_PREDICATES } from "./components.js";
import {
  CONFIG_OPTION,
  CONFIG_PREDICATES,
  configOptionPredicate,
  DERIVED_OPTION_REASON,
} from "./config.js";
import { DIRECTIVE_PREDICATES } from "./directives.js";
import { FUNCTION_PREDICATES } from "./functions.js";
import { METADATA_PREDICATES } from "./metadata.js";
import {
  ABSTAINED_WHEN_THE_RULE_CHANGED,
  REFUSED_WHEN_THE_RULE_CHANGED,
  UNPROMOTABLE_BY_CONSTRUCTION,
} from "./reopened.js";
import { ROUTING_PREDICATES, routeSegmentConfigPredicate } from "./routing.js";
import type { Catalog, NoSuggestion, PredicateSet } from "./types.js";

/**
 * Predicates built from a surface entry instead of authored against a fixed identifier. They
 * answer for families of pages that share one detection shape, so a page a later version adds
 * is covered by its own existence rather than by an edit here.
 */
const DERIVED_PREDICATES: readonly ((entry: SurfaceEntry) => PredicateSet | undefined)[] = [
  routeSegmentConfigPredicate,
  configOptionPredicate,
];

/**
 * Whether a refusal reuses the reason the derived group holds, whichever field carries the prose.
 * The check read `abstained.why` alone until the shape it was written for stopped being the only
 * one: a refusal is now a condition and an outcome, and either of those can hold the borrowed
 * sentence just as well. What the contract refuses is the claim, not the field it arrived in.
 */
function borrowsDerivedReason(silence: NoSuggestion | undefined): boolean {
  if (silence === undefined || silence.kind === "delegated") return false;
  return silence.kind === "examined"
    ? silence.condition.includes(DERIVED_OPTION_REASON) ||
        silence.outcome.includes(DERIVED_OPTION_REASON)
    : silence.why.includes(DERIVED_OPTION_REASON);
}

/**
 * The words a reason has no use for. Deliberately crude, and a list rather than a judgement: the
 * failure mode is a sentence written in the corpus's voice — *no fixture has this shape* — and
 * every one of those contains one of these. A reason about code names a file, an export, a call or
 * a directive, and never a project.
 *
 * The names of the projects a suite references are the other half of that voice. They are not
 * listed here, because shipped code names no project it was tested on: a test passes the names of
 * the projects it references, and assembly, which has none, checks the generic words alone.
 */
const CORPUS_VOICE: readonly string[] = ["fixture", "fixtures", "corpus", "referenced project"];

/** Matched on word boundaries identifiers survive, so a name holding `_` or `-` stays one word. */
function voicePattern(word: string): RegExp {
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`);
}

const CORPUS_VOICE_PATTERNS: readonly (readonly [string, RegExp])[] = CORPUS_VOICE.map((word) => [
  word,
  voicePattern(word),
]);

/**
 * The first corpus word a reason uses, or nothing, including the names of the given projects.
 * Exported so a test can hold the whole set at once: assembly names one entry and stops, and the
 * set is what says the contract is met rather than that the first entry happens to meet it.
 */
export function citesTheCorpus(
  silence: NoSuggestion | undefined,
  projectNames: readonly string[] = [],
): string | undefined {
  if (silence === undefined || silence.kind === "delegated") return undefined;
  const prose =
    silence.kind === "examined" ? `${silence.condition} ${silence.outcome}` : silence.why;
  const lowered = prose.toLowerCase();
  const patterns = [
    ...CORPUS_VOICE_PATTERNS,
    ...projectNames.map((name) => [name, voicePattern(name)] as const),
  ];
  return patterns.find(([, pattern]) => pattern.test(lowered))?.[0];
}

/** The marker a page carries in its title where its frontmatter declares no version. */
const DEPRECATED_IN_TITLE = /\(deprecated\)/i;

/** Whether a set argues for its API at all, under either preset. */
function carriesACondition(predicate: PredicateSet): boolean {
  return predicate.wouldApply !== undefined || predicate.wouldApplyStrict !== undefined;
}

function derivedPredicateFor(entry: SurfaceEntry): PredicateSet | undefined {
  for (const build of DERIVED_PREDICATES) {
    const predicate = build(entry);
    if (predicate) return predicate;
  }
  return undefined;
}

/** Every hand-written predicate set. The surface they attach to is derived, never listed here. */
export const ALL_PREDICATES: readonly PredicateSet[] = [
  ...ROUTING_PREDICATES,
  ...METADATA_PREDICATES,
  ...FUNCTION_PREDICATES,
  ...DIRECTIVE_PREDICATES,
  ...COMPONENT_PREDICATES,
  ...CONFIG_PREDICATES,
];

/**
 * Joins the derived surface with the authored predicates, and reports the gap in both
 * directions: what the installed version documents that we cannot detect, and what we
 * can detect that this version does not have.
 */
export function buildCatalog(
  surface: SurfaceDerivation,
  predicates: readonly PredicateSet[] = ALL_PREDICATES,
): Catalog {
  const byId = new Map<string, PredicateSet>();
  for (const predicate of predicates) {
    if (byId.has(predicate.id)) throw new DuplicatePredicateError(predicate.id);
    // Used detection decides a bucket and runs under the default preset, so the tier the release
    // plan holds back cannot sit here whatever else the set carries — which is the case today's
    // guard let through whenever a set happened to carry a reopening.
    if (predicate.cost === "BUILD") throw new UsedDetectionBuildTierError(predicate.id);
    const carriesACondition =
      predicate.wouldApply !== undefined || predicate.wouldApplyStrict !== undefined;
    if (predicate.conditionCost !== undefined && !carriesACondition) {
      throw new ConditionCostWithoutConditionError(predicate.id);
    }
    // The attribution exists for the set carrying two conditions that read different things, where
    // one tier field has to stand for both. Naming a condition without a tier attributes nothing,
    // and naming one where a single condition exists says the entry has a choice it does not.
    if (predicate.conditionCostReadBy !== undefined) {
      if (predicate.conditionCost === undefined) {
        throw new UnattributedConditionCostError(predicate.id, "no tier");
      }
      if (predicate.wouldApply === undefined || predicate.wouldApplyStrict === undefined) {
        throw new UnattributedConditionCostError(predicate.id, "no second condition");
      }
    }
    if (predicate.conditionCostNarrows === true && predicate.conditionCost !== "GRAFO") {
      throw new NarrowingWithoutGraphTierError(predicate.id);
    }
    if (predicate.conditionCost === "BUILD" && predicate.reopenedFrom === undefined) {
      throw new PrematureBuildTierError(predicate.id);
    }
    // Stated of the preset rather than of the tier, which is what makes it exact. The release plan
    // holds the graph back, and the catalog already carries `GRAFO` conditions no default run
    // performs; a rule written against the tier would refuse those too.
    //
    // It takes no reopened-condition exception, unlike the guard above. That exception is a proxy
    // for "this condition is strict-only", and here the preset is tested directly — so the proxy
    // would be strictly worse: it would admit a reopened `GRAFO` condition promoted to the default
    // preset, which is the one case this exists to catch.
    if (predicate.cost === "GRAFO") {
      throw new GraphTierUnderTheDefaultPresetError(predicate.id, "used detection");
    }
    if (predicate.conditionCost === "GRAFO") {
      // Where two conditions read different things the tier is the dearer of them, so the entry's
      // record of which one performs the reading is what says whether the default preset asks for
      // it. Absent, the set's conditions read alike and a default-preset one performs it too.
      const readByStrict = predicate.conditionCostReadBy === "strict";
      const defaultAsksForIt =
        predicate.wouldApply !== undefined && predicate.wouldApplyPreset !== "strict";
      // What the release plan holds back is a finding resting on the graph, because a barrel
      // over-reaches. A reading that only removes files a single read selected rests none on it,
      // so it runs where the single read runs. The mark is a claim, and the fixtures test it.
      const onlyNarrows = predicate.conditionCostNarrows === true;
      if (!readByStrict && defaultAsksForIt && !onlyNarrows) {
        throw new GraphTierUnderTheDefaultPresetError(predicate.id, "a default-preset condition");
      }
    }
    // A conversion is the only way an id on that list stops answering with a refusal, and the
    // refusal has to survive it. Read on the set rather than on the entry because the surface may
    // not document the id at all, and a conversion that drops its measurement is wrong either way.
    if (
      REFUSED_WHEN_THE_RULE_CHANGED.has(predicate.id) &&
      predicate.noSuggestion === undefined &&
      predicate.reopenedFrom === undefined
    ) {
      throw new DroppedRefusalError(predicate.id);
    }
    // The mirror of the check above, and it is per shape rather than per field. An entry that
    // answered with no verdict of that kind has nothing of that kind to reopen, so the carrier
    // would put a sentence about a measurement nobody took where the contract promises one
    // somebody did. A refusal's condition and outcome may only be carried by an id that was
    // refused; an abstention may only be carried, by reference, by an id that abstained.
    const reopened = predicate.reopenedFrom;
    if (reopened !== undefined) {
      const register =
        reopened.from === undefined
          ? REFUSED_WHEN_THE_RULE_CHANGED
          : ABSTAINED_WHEN_THE_RULE_CHANGED;
      if (!register.has(reopened.from ?? predicate.id)) {
        throw new UnrecordedReopeningError(predicate.id);
      }
      // An abstention travels by reference, and a reference to somebody else's is an entry
      // arguing from an objection written about a different API.
      if (reopened.from !== undefined && reopened.from !== predicate.id) {
        throw new UnrecordedReopeningError(predicate.id);
      }
    }
    // The mirror of the dropped-refusal check, for the other register. A converted abstention that
    // ships without its carrier loses the only record that anybody ever decided the question was
    // not about code.
    if (
      ABSTAINED_WHEN_THE_RULE_CHANGED.has(predicate.id) &&
      predicate.noSuggestion === undefined &&
      predicate.reopenedFrom === undefined
    ) {
      throw new DroppedRefusalError(predicate.id);
    }
    // A condition whose whole content is that the project does not use the API cannot be promoted:
    // every project it fires on is an instance of the objection it was withheld for, so a fire
    // count reads as support and is not.
    if (predicate.restatesUsed === true && predicate.wouldApply !== undefined) {
      throw new PromotedRestatementError(predicate.id);
    }
    // Registered because no evidence can answer the objection, not because none has arrived yet.
    // A later change promoting one of these fails here rather than being reviewed on its merits.
    if (UNPROMOTABLE_BY_CONSTRUCTION.has(predicate.id) && predicate.wouldApply !== undefined) {
      throw new UnpromotableConditionError(predicate.id);
    }
    byId.set(predicate.id, predicate);
  }

  if (surface.status !== "available") {
    return {
      entries: [],
      documentedNotCovered: [],
      documentedNotAdoptable: [],
      predicatesWithoutSurface: [...byId.keys()].sort(),
    };
  }

  const entries: { surface: SurfaceEntry; predicates: PredicateSet }[] = [];
  const documentedNotCovered: SurfaceEntry[] = [];
  const documentedNotAdoptable: SurfaceEntry[] = [];
  const matchedIds = new Set<string>();
  const documentedIds = new Set(surface.entries.map((entry) => entry.id));
  const delegations: { readonly id: string; readonly to: string }[] = [];

  for (const entry of surface.entries) {
    // An authored predicate wins: a derived one answers for a family, and naming a page
    // explicitly is how an author overrides that.
    const predicate = byId.get(entry.id) ?? derivedPredicateFor(entry);
    if (!predicate) {
      // Adoptability decides which list an uncovered entry lands in, never whether it joins a
      // predicate: an authored predicate below still wins over the classification.
      (entry.adoptable ? documentedNotCovered : documentedNotAdoptable).push(entry);
      continue;
    }
    // The type already refuses a set carrying neither, so this catches the one that reached here
    // through a cast — which is exactly where an unexplained silence would slip back in.
    const { id: predicateId } = predicate;
    if (
      predicate.wouldApply === undefined &&
      predicate.wouldApplyStrict === undefined &&
      predicate.noSuggestion === undefined
    ) {
      throw new SilentPredicateError(predicateId);
    }
    // The derived group's reason speaks for pages nobody examined. An authored entry reusing it
    // would report that same non-examination about a page that was, in fact, examined.
    if (byId.has(entry.id) && borrowsDerivedReason(predicate.noSuggestion)) {
      throw new BorrowedReasonError(predicateId);
    }
    // An authored option has been examined, so its refusal has to record the examination. Free
    // prose was the shape that let a reason restating the option's purpose pass as one recording a
    // measurement, which is the same failure the check above was written for.
    if (
      byId.has(entry.id) &&
      entry.id.startsWith(CONFIG_OPTION) &&
      predicate.noSuggestion?.kind === "abstained"
    ) {
      throw new UnexaminedRefusalError(predicateId);
    }
    // An option the reference marks deprecated in its own title gets no heuristic while that marker
    // goes unread. `preferredRegion` is the case: its title reads `preferredRegion (deprecated)`
    // and its frontmatter declares no version, so the legacy suppression — which reads the
    // frontmatter — does not see it. Detection was allowed to ship over that gap because detection
    // makes no suggestion. A suggestion is the other thing, and it would point at an option the
    // reference is steering readers away from.
    //
    // Read here for that one purpose, which moves nothing between buckets. Teaching the dismissal
    // to read it is a different change: it would move every project declaring the option into
    // *Not applicable*.
    if (DEPRECATED_IN_TITLE.test(entry.title) && carriesACondition(predicate)) {
      throw new DeprecatedOptionConditionError(predicateId);
    }
    // The register of conditions no referenced project exercises already answers "no project of
    // that shape". An entry answering it again in its own slot tells the seventh project, which
    // holds the shape, that the API was not evaluated for a reason that is false for it.
    const cited = citesTheCorpus(predicate.noSuggestion);
    if (cited !== undefined) throw new CorpusVoiceError(predicateId, cited);
    if (predicate.noSuggestion?.kind === "examined" && predicate.noSuggestion.failed === "corpus") {
      throw new CorpusExaminationError(predicateId);
    }
    if (predicate.noSuggestion?.kind === "delegated") {
      delegations.push({ id: predicateId, to: predicate.noSuggestion.to });
    }
    matchedIds.add(entry.id);
    entries.push({ surface: entry, predicates: predicate });
  }

  // Checked after the walk so the target is looked for against the whole surface, not against
  // however much of it happened to be read first.
  for (const { id, to } of delegations) {
    if (!documentedIds.has(to)) throw new DanglingDelegationError(id, to);
  }

  // Sorted by domain then id so nothing downstream depends on enumeration order.
  entries.sort((a, b) => {
    if (a.surface.domain !== b.surface.domain) return a.surface.domain < b.surface.domain ? -1 : 1;
    if (a.surface.id === b.surface.id) return 0;
    return a.surface.id < b.surface.id ? -1 : 1;
  });

  return {
    entries,
    documentedNotCovered,
    documentedNotAdoptable,
    predicatesWithoutSurface: [...byId.keys()].filter((id) => !matchedIds.has(id)).sort(),
  };
}
