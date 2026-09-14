import { sep } from "node:path";
import { DERIVED_OPTION_REASON } from "../catalog/config.js";
import type {
  Catalog,
  NoSuggestion,
  PredicateContext,
  Preset,
  Reason,
  ReopenedFrom,
  Suggestion,
  Verdict,
} from "../catalog/types.js";
import type { BoundaryLeak, BoundaryReport, DirectiveWithoutReason } from "../collect/boundary.js";
import { EMPTY_BOUNDARY } from "../collect/boundary.js";
import type { ConstraintFinding, ConstraintReport, UnreadReading } from "../collect/constraints.js";
import { EMPTY_CONSTRAINTS } from "../collect/constraints.js";
import type { ContrastReport } from "../collect/contrast.js";
import { EMPTY_CONTRAST } from "../collect/contrast.js";
import type { SurfaceEntry } from "../collect/docs.js";
import type { Declaration, Ledger } from "../collect/ledger.js";
import { EMPTY_LEDGER } from "../collect/ledger.js";
import type { ElsewhereSignal, MissingPackage } from "../collect/sources.js";
import { placedElsewhere } from "../collect/sources.js";
import type { WeightContrast, WeightReport } from "../collect/weight.js";
import { EMPTY_WEIGHT_CONTRAST, EMPTY_WEIGHTS } from "../collect/weight.js";
import { MissingEvidenceError, MissingGainError } from "../errors.js";
import type { Bucket } from "../types.js";

/**
 * The one documented status that suppresses a suggestion. The others are carried but not acted
 * on: `canary` marks an API the current release ships and this tool already detects, and `draft`
 * moves between releases, so neither says anything reliable about availability.
 */
const LEGACY_STATUS = "legacy";

/**
 * Why an entry holds no verdict. Four of the five kinds come from the catalog, where an entry
 * that never suggests has to say why; the fifth is the opposite case — a condition that was
 * written, ran, and did not hold. Printing those two as the same silence is what this separates.
 */
export type Silence = NoSuggestion | { readonly kind: "evaluated" };

export type ClassifiedEntry = {
  readonly id: string;
  readonly domain: string;
  readonly title: string;
  readonly bucket: Bucket;
  readonly evidence: readonly string[];
  readonly note?: string;
  /**
   * What adopting the API buys, on a would-apply verdict. Absent on every other bucket: a gain on
   * an API the project already uses is a line nobody asked for.
   */
  readonly gain?: string;
  /**
   * The conditions a would-apply verdict was composed from, each with the files it cites. Present
   * only when two or more fired: the note and evidence above join them, and cannot say which file
   * a sentence is about.
   */
  readonly reasons?: readonly Reason[];
  /**
   * The page the entry was derived from, on every entry whatever its bucket: the path as the
   * installed package ships it, and the same page's address on the public site.
   */
  readonly docs: { readonly path: string; readonly url: string };
  /**
   * Why the entry holds no verdict. Set on every not-evaluated entry that a flag or a missing
   * build did not already account for, because those two say something more specific.
   */
  readonly silence?: Silence;
  /** Set when the entry landed in not-evaluated because a flag was off or unresolved. */
  readonly skippedForFlag?: string;
  /**
   * Set when the entry needs the project's build to answer and there was none to read. Kept apart
   * from a missing flag: the two ask the developer for different things.
   */
  readonly needsBuild?: string;
  /**
   * Partial adoption: the API is used somewhere and would also apply elsewhere.
   * Without this a mature project reports a flawless bucket and learns nothing.
   */
  readonly alsoWouldApply?: {
    readonly note?: string;
    readonly gain: string;
    readonly evidence: readonly string[];
    readonly reasons?: readonly Reason[];
  };
  /**
   * The refusal this entry's condition replaced. Present only where a condition was reopened, and
   * printed beneath the finding so a reader sees the measurement that once said the shape does not
   * argue on its own — which is also what keeps the finding behind `--strict`.
   */
  readonly reopenedFrom?: ReopenedFrom;
  /**
   * Whether this entry's condition says only that the project does not use the API. Carried onto
   * the entry so the disclosure can count it without re-deriving what the catalog already decided.
   */
  readonly restatesUsed?: true;
  /**
   * Things the project declared that have no counterpart elsewhere. Reported next to the
   * entry without changing its bucket, and without saying which side is wrong.
   */
  readonly unmatched?: { readonly note: string; readonly declarations: readonly Declaration[] };
  /**
   * Modules on the client side of the boundary that import something only the server has.
   * Reported next to the entry without changing its bucket, and without a verdict about the build.
   */
  readonly leaks?: { readonly note: string; readonly items: readonly BoundaryLeak[] };
  /**
   * Client entries whose file shows none of the documented reasons for the directive it declares.
   * Reported next to the entry without changing its bucket — the directive is used — and present
   * with no items when the examination ran and found none, so silence is told apart from absence.
   */
  readonly directivesWithoutReason?: {
    readonly note: string;
    readonly items: readonly DirectiveWithoutReason[];
  };
  /**
   * Rules this API's documentation states that the project's code contradicts. Reported next to
   * the entry without changing its bucket: a project contradicting a constraint of an API is still
   * using that API, and moving it would misstate adoption.
   */
  readonly constraints?: { readonly note: string; readonly items: readonly ConstraintFinding[] };
};

export type CoverageResult = {
  readonly entries: readonly ClassifiedEntry[];
  readonly used: number;
  readonly evaluated: number;
  readonly notApplicable: number;
  readonly notEvaluated: number;
  /**
   * The not-evaluated count broken down by reason. The parts plus `skippedForFlag` and
   * `needingBuild` sum to `notEvaluated`, so the disclosure can be checked against the total.
   */
  readonly silence: {
    /** A condition was written, ran, and did not hold. */
    readonly evaluated: number;
    /** A condition could be written and this project decided not to. */
    readonly abstained: number;
    /** The suggestion lives on another entry. */
    readonly delegated: number;
    /** A condition is believed to exist and nobody has written it. */
    readonly unwritten: number;
  };
  /**
   * Catalog entries whose condition is believed to exist and is not written. Counted over the
   * whole catalog, not over the silence breakdown: that breakdown describes entries with no
   * verdict, so an entry the project uses hides its own backlog inside `used`.
   */
  readonly unwrittenConditions: number;
  /**
   * Config option pages still carrying the derived group reason, counted the same way and for the
   * same reason as `unwrittenConditions`: an option the project sets sits in `used` and would hide
   * its own unexamined state there. The figure falls as options are examined one at a time, and it
   * is a property of the analysed release, which documents a different number of options per
   * version, so it is counted rather than stated.
   */
  readonly unexaminedOptions: number;
  readonly skippedForFlag: number;
  /** Adoptable surface the installed version documents that this tool has no predicate for. */
  readonly documentedNotCovered: number;
  /** Surface excluded from the figure above because no project could adopt it. */
  readonly documentedNotAdoptable: number;
  /**
   * Authored predicates whose API the installed version does not document: drift the other way.
   *
   * The ids, not their number. A count reports that something this tool detects went unreported
   * and withholds the one fact that makes it actionable: a project holding
   * `app/global-not-found.tsx` — a file the route tree recognises, behind a flag the project has
   * turned on — reads its whole report without seeing the file mentioned once, and a bare "2 APIs
   * are not documented" leaves it with no way to find out that its own file is one of them. The
   * count is `length`, and anything wanting it can ask.
   */
  readonly predicatesWithoutSurface: readonly string[];
  /** Entries used somewhere that would still apply elsewhere. */
  readonly partiallyAdopted: number;
  /** Heuristics not run because they are opt-in. Never withheld silently. */
  readonly withheldHeuristics: number;
  /**
   * Conditions not run because they read a build and there was none. Kept apart from the count
   * above: a preset withholding a heuristic is a choice this tool made, and this is a reading it
   * could not take. Outside the not-evaluated breakdown too — the entries are classified, and only
   * their conditions are missing.
   */
  readonly conditionsNeedingBuild: number;
  /**
   * Entries whose condition replaced a refusal. Counted over the whole catalog rather than over
   * what fired, because the figure is about how much of the surface argues from a shape somebody
   * measured as not arguing — which is true of the entry whether or not the project trips it.
   */
  readonly reopenedConditions: number;
  /** How many of those say only that the project does not use the API. */
  readonly restatedConditions: number;
  /**
   * Verdicts naming the release the analysed project installs, and verdicts naming an older one.
   *
   * A fact about this repository rather than about the project being analysed: a verdict read
   * against 16.2 says the maintainer has not re-opened that page, which is bookkeeping and never a
   * finding. It joins the disclosure block beside the figures that already say what could not be
   * resolved, and moves no bucket.
   */
  readonly verdictsAgainstThisRelease: number;
  readonly verdictsAgainstAnOlderRelease: number;
  /**
   * Verdicts measured against a release ahead of the installed one. The mirror of the field above,
   * and a different fact: that one says a page here has not been re-read, this one says the reader
   * is behind the pages the reading was made against.
   */
  readonly verdictsAgainstANewerRelease: number;
  readonly preset: Preset;
  /** Declarations with no counterpart, across every entry. */
  readonly unmatchedDeclarations: number;
  /** Values excluded from matching because they are not literals. */
  readonly unresolvedValues: number;
  /** Modules on the client side reaching for something only the server has. */
  readonly boundaryLeaks: number;
  /** Files on the client side of the boundary, including those that declare nothing. */
  readonly clientClosure: number;
  /** How many of those declare nothing themselves. */
  readonly clientReachedWithoutDeclaring: number;
  /**
   * Files a reading placed outside the Next.js server runtime, by the signal that placed them.
   *
   * Empty when nothing fired. A file the tool declines to reason about is a decision like any
   * other here, and a reader whose script stopped being mentioned should be able to see why rather
   * than conclude the condition broke.
   */
  readonly placedElsewhere: Readonly<Partial<Record<ElsewhereSignal, number>>>;
  /**
   * Client entries reported as showing none of the documented reasons for the directive they
   * declare. Absent under a preset that withheld the examination, so a zero here is a project with
   * no such file rather than a question nobody asked.
   */
  readonly clientDirectivesWithoutReason?: number;
  /** Specifiers that resolved nowhere, so the closure is not exhaustive. */
  readonly unresolvedSpecifiers: number;
  /**
   * Workspace members this project links to and the scan read, and workspace dependencies that
   * matched no member. Absent for a project outside a workspace, so a zero is a monorepo linking
   * nothing rather than a project where the question does not arise.
   */
  readonly linkedPackages?: { readonly scanned: number; readonly unmatched: number };
  /** Packages the code imports and the project does not have. Not a verdict about adoption. */
  readonly missingPackages: readonly MissingPackage[];
  /** Documented constraints examined, so an empty section reads as checked rather than absent. */
  readonly constraintsChecked: number;
  /** How many of them the project's code contradicts. */
  readonly constraintsContradicted: number;
  /**
   * Framework defaults the comparison passed over for having no catalog entry to report against.
   * Stated so the checked figure accounts for the whole walk: a release carries defaults for
   * options it documents no page for, and a finding with nowhere to appear must not be counted.
   */
  readonly constraintsWithoutEntry: number;
  /**
   * Configuration options a check needed and could not read, with what the reader saw. Carried to
   * the report rather than counted into it: the checked figure falls either way, and only the
   * reason distinguishes a project this tool could not read from one with less to read.
   */
  readonly constraintsUnread: readonly UnreadReading[];
  /** What the build recorded against what this tool derived. */
  readonly contrast: ContrastReport;
  /** Entries left unevaluated because no build was available to answer for them. */
  readonly needingBuild: number;
  /** The client code each route carries, derived from source and reported with or without a build. */
  readonly weights: WeightReport;
  /** How far this tool's ordering of those routes agrees with the one the build recorded. */
  readonly weightContrast: WeightContrast;
};

function checked(id: string, predicate: string, verdict: Verdict): Verdict {
  if (verdict.matched && verdict.evidence.length === 0) {
    throw new MissingEvidenceError(id, predicate);
  }
  return verdict;
}

/**
 * A would-apply verdict, checked for evidence and for its gain. The type already requires the
 * gain, so this guards the callers the type checker never sees; a condition that says what it saw
 * and not what adopting buys is half a recommendation, and it is refused here the way a verdict
 * with no evidence is.
 */
function argued(id: string, predicate: string, verdict: Suggestion): Suggestion {
  checked(id, predicate, verdict);
  if (verdict.matched && verdict.gain.length === 0) {
    throw new MissingGainError(id, predicate);
  }
  return verdict;
}

/**
 * The root arrives as the caller typed it, and `next-coverage ./project/` is as ordinary an
 * invocation as `next-coverage ./project`. Slicing `root.length + 1` off the path assumed the
 * root never ends in a separator; when it does, the extra character comes out of the name, and
 * every path in the report loses its first letter — `proxy.ts` reads as `roxy.ts`. The separator
 * is trimmed before the comparison so both spellings of the same directory answer alike.
 */
function relativeTo(root: string, path: string): string {
  const base = root.length > 1 && root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return path.startsWith(base) ? path.slice(base.length + 1) || "." : path;
}

function sortedEvidence(evidence: readonly string[], root: string): readonly string[] {
  return [...evidence]
    .map((path) => relativeTo(root, path))
    .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/** A verdict's reasons, when it carries any, with each one's files cited like the entry's own. */
function sortedReasons(
  verdict: Suggestion,
  root: string,
): { readonly reasons?: readonly Reason[] } {
  if (!verdict.matched || verdict.reasons === undefined) return {};
  return {
    reasons: verdict.reasons.map((reason) => ({
      ...reason,
      evidence: sortedEvidence(reason.evidence, root),
    })),
  };
}

/**
 * Resolves each entry to exactly one bucket, evaluating used first.
 * Used beats not-applicable on purpose: dismissing an API the project demonstrably
 * calls would contradict the evidence in front of us.
 */
/** Which entry carries each kind of unmatched declaration, and how it is described. */
function unmatchedFor(id: string, ledger: Ledger) {
  if (id === "functions/cacheTag" && ledger.orphanTags.length > 0) {
    return {
      note: "declared here, and no invalidation names them anywhere in the project",
      declarations: ledger.orphanTags,
    };
  }
  if (id === "functions/revalidateTag" && ledger.phantomTags.length > 0) {
    return {
      note: "invalidated here, and nothing in the project tags data with them",
      declarations: ledger.phantomTags,
    };
  }
  const packages = ledger.undeclaredPackages.get(id);
  if (packages !== undefined && packages.length > 0) {
    return {
      note: "named here, and the project manifest declares no such dependency",
      declarations: packages,
    };
  }
  if (id === "functions/revalidatePath" && ledger.unmatchedPaths.length > 0) {
    return {
      note: "revalidated here, and no route in the app serves them",
      declarations: ledger.unmatchedPaths,
    };
  }
  return undefined;
}

/**
 * The client directive is the entry that describes the boundary, so it is where a module found on
 * the wrong side of it is reported.
 */
const LEAK_ENTRY = "directives/use-client";

function leaksFor(id: string, boundary: BoundaryReport) {
  if (id !== LEAK_ENTRY || boundary.leaks.length === 0) return undefined;
  return {
    note: "these modules are on the client side of the boundary and import server-only code",
    items: boundary.leaks,
  };
}

/**
 * The same entry describes the boundary, so the directive that argues nothing for the side it
 * chose is reported there too. An examination that ran and found nothing is kept — an empty list
 * says the question was asked, and its absence says the preset withheld it.
 */
function directivesWithoutReasonFor(id: string, boundary: BoundaryReport) {
  if (id !== LEAK_ENTRY || boundary.directivesWithoutReason === undefined) return undefined;
  return {
    note: "these files declare the client directive and show none of the documented reasons for it",
    items: boundary.directivesWithoutReason,
  };
}

/**
 * A constraint finding belongs to the entry whose documentation states the rule, so it is reported
 * under that entry rather than in a channel of its own with no context.
 */
const CONSTRAINT_NOTES = {
  "slot-mode":
    "these slots render dynamically because a sibling at the same level does, so they are not prerendered",
  "restates-default":
    "the framework applies these to every project, so the configuration states what it already does",
  "intercepted-route":
    "the configuration routes these paths elsewhere, so the files answering at them are not reached",
  "unprefixed-asset":
    "the documentation asks for this value to be written here by hand, and these are requested without it",
  "missing-module":
    "the framework imports these on the client before hydration, and the project does not answer for them",
  "bundler-scope":
    "the documentation scopes these to a bundler this project's scripts do not run, so the framework never reads them",
  "failing-combination":
    "the documentation names this combination of a setting and an installed version, and says what it does",
  "segment-config-removed":
    "the documentation says this option removes these route segment configs, and these segments still export them",
  "absent-prerequisite":
    "the page names what this option needs to apply at all, and the project does not have it",
} as const;

function constraintsFor(id: string, constraints: ConstraintReport) {
  const items = constraints.findings.filter((finding) => finding.entry === id);
  const first = items[0];
  if (first === undefined) return undefined;
  // The note explains the rule, and the rules differ. One note for the channel described the
  // only constraint it had, and would misdescribe every one added beside it.
  return { note: CONSTRAINT_NOTES[first.kind], items };
}

/** The release a verdict or an installation names, down to the minor. */
type Release = { readonly major: number; readonly minor: number };

/**
 * The major and minor of a version, ignoring everything after them.
 *
 * A patch and a prerelease tag are deliberately dropped. A verdict is a reading of a documented
 * page, and a patch release publishes the same pages as the minor it belongs to, so `16.3.4`
 * against a verdict measured on `16.3.0` names the same documentation.
 */
function releaseOf(version: string): Release | undefined {
  const parsed = /^(\d+)\.(\d+)/.exec(version);
  if (parsed === null) return undefined;
  return { major: Number(parsed[1]), minor: Number(parsed[2]) };
}

/** Negative where `left` is behind `right`, positive where it is ahead, zero where they match. */
function compareReleases(left: Release, right: Release): number {
  return left.major === right.major ? left.minor - right.minor : left.major - right.major;
}

/**
 * How many verdicts name the release in play, how many name one behind it, and how many name one
 * ahead of it.
 *
 * Compared by major and minor. A patch release documents the pages the minor documents, so a
 * project on `16.3.4` reading verdicts measured on `16.3.0` has no staleness to disclose, and
 * counting one would fire the whole catalog at every patch bump — which is what comparing the
 * strings did: sixty-eight of the seventy authored verdicts name one release, so every project not
 * on exactly that patch was told nearly every verdict was stale.
 *
 * Both directions are counted, because a string comparison cannot tell them apart and the sentence
 * it fed said "older" of both. A project on a release behind the catalog reads verdicts measured
 * ahead of it, which is a different fact with a different remedy: the first says this repository
 * has not re-read a page, the second says the reader is behind the pages it was read against.
 *
 * A version neither side can parse is counted as naming a different release rather than the same
 * one, since nothing establishes that it matches.
 *
 * With no installed release to compare against, nothing is counted any way: a run that cannot say
 * what it is running cannot say a verdict is behind it.
 */
function datedVerdicts(
  catalog: Catalog,
  context: PredicateContext,
): {
  verdictsAgainstThisRelease: number;
  verdictsAgainstAnOlderRelease: number;
  verdictsAgainstANewerRelease: number;
} {
  const empty = {
    verdictsAgainstThisRelease: 0,
    verdictsAgainstAnOlderRelease: 0,
    verdictsAgainstANewerRelease: 0,
  };
  const version = context.project.installedNext?.version;
  const installed = version === undefined ? undefined : releaseOf(version);
  if (installed === undefined) return empty;

  let current = 0;
  let older = 0;
  let newer = 0;
  for (const entry of catalog.entries) {
    const silence = entry.predicates.noSuggestion;
    // The unwritten kind names no release, and the omission is deliberate: it records that nobody
    // has written a condition, which is true of every release at once.
    if (silence === undefined || silence.kind === "unwritten") continue;
    const measured = releaseOf(silence.measuredAgainst);
    const order = measured === undefined ? undefined : compareReleases(measured, installed);
    if (order === 0) current += 1;
    else if (order !== undefined && order > 0) newer += 1;
    else older += 1;
  }
  return {
    verdictsAgainstThisRelease: current,
    verdictsAgainstAnOlderRelease: older,
    verdictsAgainstANewerRelease: newer,
  };
}

/** Files each signal placed outside the server runtime, counted once per run for the summary. */
function countPlacedElsewhere(
  context: PredicateContext,
): Readonly<Partial<Record<ElsewhereSignal, number>>> {
  const conventions = new Set<string>();
  for (const node of context.tree.nodes) {
    for (const convention of node.conventions) {
      if (convention.skippedForFlag === undefined) conventions.add(convention.file);
    }
  }
  const counts: Partial<Record<ElsewhereSignal, number>> = {};
  for (const file of context.sources.files) {
    const signal = placedElsewhere(file, (path) => conventions.has(path));
    if (signal !== undefined) counts[signal] = (counts[signal] ?? 0) + 1;
  }
  return counts;
}

export function classify(
  catalog: Catalog,
  context: PredicateContext,
  preset: Preset = "default",
  ledger: Ledger = EMPTY_LEDGER,
  boundary: BoundaryReport = EMPTY_BOUNDARY,
  constraints: ConstraintReport = EMPTY_CONSTRAINTS,
  contrast: ContrastReport = EMPTY_CONTRAST,
  weights: WeightReport = EMPTY_WEIGHTS,
  weightContrast: WeightContrast = EMPTY_WEIGHT_CONTRAST,
): CoverageResult {
  const root = context.project.root;
  const entries: ClassifiedEntry[] = [];
  let withheldHeuristics = 0;
  /** Conditions that could not run for want of a build, on entries the run classified anyway. */
  let conditionsNeedingBuild = 0;

  // The directive examination is opt-in like the conditions below, and runs before classification
  // rather than inside this loop, so the preset is what says it was withheld. Counted whatever the
  // project holds: a channel that never ran must not read as a project with nothing to report.
  if (preset !== "strict") withheldHeuristics += 1;

  /**
   * The would-apply verdict, honouring the preset one condition at a time. An entry may hold a
   * proven argument and an observed one; only the observed one is held back, and a condition held
   * back is counted even when the entry still reports on its other one — otherwise the report
   * shows a suggestion while silently withholding a second argument for the same entry.
   */
  const wouldApplyOf = (
    predicates: Catalog["entries"][number]["predicates"],
    surface: SurfaceEntry,
  ): Suggestion | undefined => {
    const { id, wouldApply, wouldApplyStrict } = predicates;
    const admitted = predicates.wouldApplyPreset !== "strict" || preset === "strict";
    if (wouldApply !== undefined && !admitted) withheldHeuristics += 1;
    if (wouldApplyStrict !== undefined && preset !== "strict") withheldHeuristics += 1;

    // A condition that reads the build and has none is withheld, and the entry is not: it was
    // classified from its used detection, which read the configuration. Counted apart from the
    // heuristics a preset withholds, because a preset withholding one is a choice and this is a
    // reading nobody could take.
    if (predicates.conditionCost === "BUILD" && context.build.status === "unresolved") {
      if (wouldApply !== undefined || wouldApplyStrict !== undefined) conditionsNeedingBuild += 1;
      return undefined;
    }

    const proven =
      wouldApply !== undefined && admitted
        ? argued(id, "wouldApply", wouldApply(context, surface))
        : undefined;
    if (proven?.matched) return proven;

    if (wouldApplyStrict !== undefined && preset === "strict") {
      const observed = argued(id, "wouldApplyStrict", wouldApplyStrict(context, surface));
      if (observed.matched) return observed;
    }
    return proven;
  };

  for (const entry of catalog.entries) {
    const { id, domain, title } = entry.surface;
    const { predicates } = entry;
    const found = unmatchedFor(id, ledger);
    const unmatched =
      found === undefined
        ? undefined
        : {
            note: found.note,
            declarations: found.declarations.map((declaration) => ({
              value: declaration.value,
              files: sortedEvidence(declaration.files, root),
            })),
          };
    const foundLeaks = leaksFor(id, boundary);
    const leaks =
      foundLeaks === undefined
        ? undefined
        : {
            note: foundLeaks.note,
            items: foundLeaks.items.map((leak) => ({
              module: relativeTo(root, leak.module),
              specifier: leak.specifier,
              // The chain keeps its order: it is the path a reader follows, not a set.
              chain: leak.chain.map((path) => relativeTo(root, path)),
            })),
          };
    const foundDirectives = directivesWithoutReasonFor(id, boundary);
    const directivesWithoutReason =
      foundDirectives === undefined
        ? undefined
        : {
            note: foundDirectives.note,
            items: foundDirectives.items.map((finding) => ({
              module: relativeTo(root, finding.module),
              exclusiveModules: finding.exclusiveModules,
            })),
          };
    const foundConstraints = constraintsFor(id, constraints);
    const contradicted =
      foundConstraints === undefined
        ? undefined
        : {
            note: foundConstraints.note,
            items: foundConstraints.items.map((finding) =>
              finding.kind === "slot-mode"
                ? {
                    ...finding,
                    segment: relativeTo(root, finding.segment),
                    staticSlots: finding.staticSlots.map((slot) => ({
                      ...slot,
                      directory: relativeTo(root, slot.directory),
                    })),
                    // The chain keeps its order: it is the path a reader follows, not a set.
                    causeChain: finding.causeChain.map((path) => relativeTo(root, path)),
                  }
                : finding.kind === "intercepted-route"
                  ? {
                      ...finding,
                      source: relativeTo(root, finding.source),
                      // The pattern is a URL and stays as written; the file it names is a path.
                      routes: finding.routes.map((route) => ({
                        ...route,
                        serves: relativeTo(root, route.serves),
                      })),
                    }
                  : { ...finding, source: relativeTo(root, finding.source) },
            ),
          };
    const base = {
      id,
      domain,
      title,
      docs: { path: entry.surface.docRelativePath, url: entry.surface.docUrl },
      ...(unmatched === undefined ? {} : { unmatched }),
      ...(leaks === undefined ? {} : { leaks }),
      ...(directivesWithoutReason === undefined ? {} : { directivesWithoutReason }),
      ...(contradicted === undefined ? {} : { constraints: contradicted }),
      ...(predicates.reopenedFrom === undefined ? {} : { reopenedFrom: predicates.reopenedFrom }),
      ...(predicates.restatesUsed === true ? { restatesUsed: true as const } : {}),
    };

    const flag = predicates.requiredFlag;
    if (flag !== undefined && !context.isFlagEnabled(flag)) {
      entries.push({ ...base, bucket: "not-evaluated", evidence: [], skippedForFlag: flag });
      continue;
    }

    // No build to read is an absence of evidence, never evidence of absence: a used detection that
    // needs one reports no verdict rather than dismissing or suggesting its API. A condition that
    // needs one is handled where conditions are, because it leaves the entry classifiable.
    if (predicates.cost === "BUILD" && context.build.status === "unresolved") {
      entries.push({
        ...base,
        bucket: "not-evaluated",
        evidence: [],
        needsBuild: context.build.reason,
      });
      continue;
    }

    const used = checked(id, "detectUsed", predicates.detectUsed(context, entry.surface));
    if (used.matched) {
      const alsoApplies = wouldApplyOf(predicates, entry.surface);
      entries.push({
        ...base,
        bucket: "used",
        evidence: sortedEvidence(used.evidence, root),
        ...(used.note === undefined ? {} : { note: used.note }),
        ...(alsoApplies?.matched
          ? {
              alsoWouldApply: {
                evidence: sortedEvidence(alsoApplies.evidence, root),
                ...(alsoApplies.note === undefined ? {} : { note: alsoApplies.note }),
                gain: alsoApplies.gain,
                ...sortedReasons(alsoApplies, root),
              },
            }
          : {}),
      });
      continue;
    }

    // Evaluated before the authored dismissal so a documented status outranks a hand-written
    // guess about the same entry, and before the heuristic so it is never even run: an API
    // Next.js has moved past must not be suggested, nor counted as withheld by a preset. That
    // count promises --strict reveals what it holds back, and this is not held back.
    if (entry.surface.status === LEGACY_STATUS) {
      entries.push({
        ...base,
        bucket: "not-applicable",
        // The page carrying the status is the evidence, so a reader can check the dismissal
        // against the same source it was read from. Cited in the form `docs.path` already
        // publishes: the absolute path lies under `node_modules`, which is inside the project root
        // only by accident of where it sits — and on a run where it is not, the contract came out
        // carrying the producing machine's directories.
        evidence: [entry.surface.docRelativePath],
        note: `its documentation declares it ${LEGACY_STATUS}`,
      });
      continue;
    }

    const dismissed = predicates.notApplicable
      ? checked(id, "notApplicable", predicates.notApplicable(context, entry.surface))
      : undefined;
    if (dismissed?.matched) {
      entries.push({
        ...base,
        bucket: "not-applicable",
        evidence: sortedEvidence(dismissed.evidence, root),
        ...(dismissed.note === undefined ? {} : { note: dismissed.note }),
      });
      continue;
    }

    const suggested = wouldApplyOf(predicates, entry.surface);
    if (suggested?.matched) {
      entries.push({
        ...base,
        bucket: "would-apply",
        evidence: sortedEvidence(suggested.evidence, root),
        ...(suggested.note === undefined ? {} : { note: suggested.note }),
        gain: suggested.gain,
        ...sortedReasons(suggested, root),
      });
      continue;
    }

    entries.push({
      ...base,
      bucket: "not-evaluated",
      evidence: [],
      // A set with no reason cannot reach here: the catalog refuses one. Falling back to
      // `evaluated` keeps this total rather than restating that refusal as a second guard.
      silence: predicates.noSuggestion ?? { kind: "evaluated" },
    });
  }

  entries.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
  });

  const count = (bucket: Bucket): number => entries.filter((e) => e.bucket === bucket).length;
  const silenceCount = (kind: Silence["kind"]): number =>
    entries.filter((e) => e.silence?.kind === kind).length;
  const used = count("used");
  const notApplicable = count("not-applicable");
  const notEvaluated = count("not-evaluated");

  return {
    entries,
    used,
    // Not-applicable and not-evaluated leave both terms of the ratio, so the figure
    // never reads as coverage of things that were never in play.
    evaluated: used + count("would-apply"),
    notApplicable,
    notEvaluated,
    silence: {
      evaluated: silenceCount("evaluated"),
      // An examined option is an abstention with its examination recorded, so it is counted with
      // the abstentions rather than given a line of its own: the breakdown answers why an entry
      // holds no verdict, and for a reader that answer is the same one.
      abstained: silenceCount("abstained") + silenceCount("examined"),
      delegated: silenceCount("delegated"),
      unwritten: silenceCount("unwritten"),
    },
    unwrittenConditions: catalog.entries.filter(
      (e) => e.predicates.noSuggestion?.kind === "unwritten",
    ).length,
    unexaminedOptions: catalog.entries.filter(
      (e) =>
        e.predicates.noSuggestion?.kind === "abstained" &&
        e.predicates.noSuggestion.why === DERIVED_OPTION_REASON,
    ).length,
    skippedForFlag: entries.filter((e) => e.skippedForFlag !== undefined).length,
    documentedNotCovered: catalog.documentedNotCovered.length,
    documentedNotAdoptable: catalog.documentedNotAdoptable.length,
    predicatesWithoutSurface: catalog.predicatesWithoutSurface,
    partiallyAdopted: entries.filter((e) => e.alsoWouldApply !== undefined).length,
    contrast,
    weights,
    weightContrast,
    needingBuild: entries.filter((e) => e.needsBuild !== undefined).length,
    constraintsChecked: constraints.checked,
    constraintsContradicted: constraints.findings.length,
    constraintsWithoutEntry: constraints.withoutEntry,
    constraintsUnread: constraints.unread,
    unmatchedDeclarations: entries.reduce(
      (total, entry) => total + (entry.unmatched?.declarations.length ?? 0),
      0,
    ),
    unresolvedValues: ledger.unresolved,
    boundaryLeaks: boundary.leaks.length,
    clientClosure: boundary.closure,
    clientReachedWithoutDeclaring: boundary.reachedWithoutDeclaring,
    placedElsewhere: countPlacedElsewhere(context),
    ...(boundary.directivesWithoutReason === undefined
      ? {}
      : { clientDirectivesWithoutReason: boundary.directivesWithoutReason.length }),
    unresolvedSpecifiers: boundary.unresolvedSpecifiers,
    // Only where the project links to something. A zero would read as a monorepo linking nothing,
    // which is a different fact from a project outside any workspace.
    ...(context.sources.linked.scanned === 0 && context.sources.linked.unmatched === 0
      ? {}
      : { linkedPackages: context.sources.linked }),
    missingPackages: context.sources.resolution.missingPackages,
    withheldHeuristics,
    conditionsNeedingBuild,
    reopenedConditions: entries.filter((entry) => entry.reopenedFrom !== undefined).length,
    restatedConditions: entries.filter((entry) => entry.restatesUsed === true).length,
    ...datedVerdicts(catalog, context),
    preset,
  };
}
