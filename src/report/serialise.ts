import type { Reason } from "../catalog/types.js";
import type { BoundaryLeak } from "../collect/boundary.js";
import type { ConstraintFinding } from "../collect/constraints.js";
import type { ContrastReport } from "../collect/contrast.js";
import type { Declaration } from "../collect/ledger.js";
import type { MissingPackage } from "../collect/sources.js";
import type { RankedRoute, WeightContrast, WeightReport } from "../collect/weight.js";
import type { Bucket } from "../types.js";
import type { ClassifiedEntry, CoverageResult, Silence } from "./classify.js";
import type { RenderOptions } from "./render.js";

/**
 * Raised when a field is removed or its meaning changes. Adding one does not raise it, so a
 * consumer reading the fields it knows keeps working across such an addition.
 */
/**
 * 3 since `constraints.unread[].option` became `subject`. The channel carries readings that are not
 * configuration options — the version of an installed package among them — and a field named for
 * the narrower case would have had to lie about the wider one. A consumer reading `option` finds
 * nothing, which is the removal this version exists to declare.
 *
 * 2 was `totals.predicatesWithoutSurface` becoming the list of ids it used to count. A consumer
 * reading it as a number gets an array, which is the kind of change the version exists to declare.
 */
export const SCHEMA_VERSION = 3;

/** Why an entry holds no verdict. The distinction the report is built around, published. */
export type SerialisedSilence =
  | { readonly kind: "abstained"; readonly why: string }
  | { readonly kind: "examined"; readonly condition: string; readonly outcome: string }
  | { readonly kind: "delegated"; readonly to: string }
  | { readonly kind: "unwritten"; readonly why: string }
  | { readonly kind: "evaluated" };

export type SerialisedDeclaration = {
  readonly value: string;
  readonly files: readonly string[];
};

export type SerialisedLeak = {
  readonly module: string;
  readonly specifier: string;
  /** From the file declaring the client directive down to the module itself. */
  readonly chain: readonly string[];
};

/**
 * A file declaring the client directive while showing none of the documented reasons for it, with
 * the modules that reach the client through it and no other client entry. A count of modules the
 * graph walks, never a size and never a claim about what a bundler would emit.
 */
export type SerialisedDirectiveWithoutReason = {
  readonly module: string;
  readonly exclusiveModules: number;
};

/**
 * A documented rule the project's code contradicts. Nine kinds, discriminated by `kind`, and
 * converted one at a time below so that a tenth cannot be added without a decision about it.
 */
export type SerialisedConstraint =
  | {
      readonly kind: "slot-mode";
      readonly entry: string;
      readonly segment: string;
      readonly staticSlots: readonly { readonly slot: string; readonly directory: string }[];
      readonly cause: string;
      readonly causeChain: readonly string[];
      readonly otherDynamic: number;
    }
  | {
      readonly kind: "restates-default";
      readonly entry: string;
      readonly option: string;
      readonly packages: readonly string[];
      readonly whatNextDoes: string;
      readonly source: string;
    }
  | {
      readonly kind: "intercepted-route";
      readonly entry: string;
      readonly option: string;
      readonly routes: readonly { readonly pattern: string; readonly serves: string }[];
      readonly source: string;
      readonly unread: number;
    }
  | {
      readonly kind: "unprefixed-asset";
      readonly entry: string;
      readonly option: string;
      readonly prefix: string;
      readonly assets: readonly { readonly file: string; readonly value: string }[];
      readonly source: string;
    }
  | {
      readonly kind: "missing-module";
      readonly entry: string;
      readonly option: string;
      readonly modules: readonly { readonly value: string; readonly as: string }[];
      readonly source: string;
      readonly unread: number;
    }
  | {
      readonly kind: "bundler-scope";
      readonly entry: string;
      readonly settings: readonly {
        readonly option: string;
        readonly value?: string;
        readonly scope: string;
      }[];
      readonly running: readonly string[];
      readonly source: string;
    }
  | {
      readonly kind: "failing-combination";
      readonly entry: string;
      readonly option: string;
      readonly withPackage: string;
      readonly majorInstalled: number;
      readonly consequence: string;
      readonly source: string;
    }
  | {
      readonly kind: "segment-config-removed";
      readonly entry: string;
      readonly option: string;
      readonly segments: readonly { readonly file: string; readonly exported: string }[];
      readonly consequence: string;
      readonly source: string;
    }
  | {
      readonly kind: "absent-prerequisite";
      readonly entry: string;
      readonly option: string;
      readonly needs: string;
      readonly source: string;
    };

export type SerialisedEntry = {
  readonly id: string;
  readonly domain: string;
  readonly bucket: Bucket;
  readonly evidence: readonly string[];
  readonly note?: string;
  /** What adopting the API buys. Present only on a would-apply entry, so a consumer can tell a suggestion by the field. */
  readonly gain?: string;
  /**
   * The conditions `note`, `gain` and `evidence` join, each with its own files. Present only when
   * two or more fired, so a consumer can tell which file each sentence is about.
   */
  readonly reasons?: readonly Reason[];
  /**
   * The verdict this entry's condition replaced, where there was one. A script reading the contract
   * can weigh a reopened finding the way the report lets a reader weigh it, instead of taking every
   * suggestion as equally argued.
   *
   * Two shapes, and which one arrives says what was reopened: a refusal carries the condition tried
   * and the outcome it produced, and an abstention carries the one sentence saying the question was
   * not about code. A consumer that only handles the first will see the field absent where it is
   * the second, which is the right failure — it is not the same claim.
   */
  readonly reopenedFrom?:
    | { readonly condition: string; readonly outcome: string }
    | { readonly from: string; readonly why: string };
  /**
   * The page the entry was derived from: its path relative to the bundled API reference as the
   * installed package ships it, and the same page's address on the public site. On every entry,
   * because it is a fact about the entry and not about the verdict.
   */
  readonly docs: { readonly path: string; readonly url: string };
  /** Why the entry holds no verdict, when a flag or a missing build did not already account for it. */
  readonly silence?: SerialisedSilence;
  /** The flag that was off or unresolved, when that is why the entry was skipped. */
  readonly skippedForFlag?: string;
  /** What the entry needed a build to answer, when there was none to read. */
  readonly needsBuild?: string;
  /** Used somewhere and would still apply elsewhere. Without this, partial adoption reads as used. */
  readonly alsoWouldApply?: {
    readonly note?: string;
    readonly gain: string;
    readonly evidence: readonly string[];
    readonly reasons?: readonly Reason[];
  };
  /** Declarations with no counterpart elsewhere in the project. Never a claim that either side is wrong. */
  readonly unmatched?: {
    readonly note: string;
    readonly declarations: readonly SerialisedDeclaration[];
  };
  /** Client-side modules importing something only the server has, with the chain that causes it. */
  readonly leaks?: { readonly note: string; readonly items: readonly SerialisedLeak[] };
  /**
   * Client entries showing none of the documented reasons for the directive they declare. Absent
   * where the preset withheld the examination and present and empty where it ran and found none, so
   * a consumer never reads a question nobody asked as an answer of none.
   */
  readonly directivesWithoutReason?: readonly SerialisedDirectiveWithoutReason[];
  /** Documented rules this entry's API states that the project contradicts. The bucket does not move. */
  readonly constraints?: { readonly note: string; readonly items: readonly SerialisedConstraint[] };
};

/** Every count the report's summary states, so a consumer does not reconstruct the summary. */
export type SerialisedTotals = {
  readonly used: number;
  readonly evaluated: number;
  readonly notApplicable: number;
  readonly notEvaluated: number;
  /**
   * The not-evaluated count by reason. These four plus `skippedForFlag` and `needingBuild` sum to
   * `notEvaluated`, so a consumer can check the disclosure against the total. The figure the report
   * calls "had no verdict" is `notEvaluated` less those two, and is left to the subtraction for the
   * same reason the kilobytes and the agreement percentage are: the contract publishes the value,
   * and the arithmetic on it belongs to whoever is displaying it.
   *
   * `abstained` here counts the entries whose `silence.kind` is `abstained` *and* those whose kind
   * is `examined`, which is the grouping the rendered report prints. Grouping the entries by their
   * own `kind` therefore gives four figures that do not match these, and the difference is that
   * split rather than a defect. It only became visible once both sides were published, which is
   * the kind of thing publishing both sides is for.
   */
  readonly silence: {
    readonly evaluated: number;
    readonly abstained: number;
    readonly delegated: number;
    readonly unwritten: number;
  };
  readonly skippedForFlag: number;
  readonly needingBuild: number;
  readonly partiallyAdopted: number;
  readonly unmatchedDeclarations: number;
  readonly unresolvedValues: number;
  readonly clientClosure: number;
  /** Files a reading placed outside the Next.js server runtime, keyed by the signal. */
  readonly placedElsewhere: Readonly<Partial<Record<string, number>>>;
  readonly clientReachedWithoutDeclaring: number;
  /**
   * Client entries reported as showing none of the documented reasons for their directive. Absent
   * where the preset withheld the examination, for the same reason the entry's own field is: a zero
   * would read as a project with no such file rather than as a question nobody asked.
   */
  readonly clientDirectivesWithoutReason?: number;
  readonly unresolvedSpecifiers: number;
  /**
   * Workspace members linked into the scan, and workspace dependencies matching no member. Absent
   * for a project outside a workspace: a consumer reading zero would take it for a monorepo that
   * links nothing, which is a different fact.
   */
  readonly linkedPackages?: { readonly scanned: number; readonly unmatched: number };
  readonly boundaryLeaks: number;
  readonly withheldHeuristics: number;
  /** Conditions that read a build, on runs with none to read. Their entries are still classified. */
  readonly conditionsNeedingBuild: number;
  readonly reopenedConditions: number;
  /** How many of those say only that the API is unused: the Used bucket read backwards. */
  readonly restatedConditions: number;
  /** Verdicts read against the installed release, and verdicts read against an older one. */
  readonly verdictsAgainstThisRelease: number;
  readonly verdictsAgainstAnOlderRelease: number;
  readonly verdictsAgainstANewerRelease: number;
  readonly unwrittenConditions: number;
  readonly unexaminedOptions: number;
  readonly documentedNotCovered: number;
  readonly documentedNotAdoptable: number;
  /**
   * The APIs this tool detects that the installed version does not document, by id.
   *
   * A list where schema 1 published a count. A consumer reading the count alone had the same
   * problem the text report had: an API this tool detects went unreported, and nothing said which.
   */
  readonly predicatesWithoutSurface: readonly string[];
  readonly missingPackages: readonly {
    readonly name: string;
    readonly declared: string;
    readonly references: number;
  }[];
};

/**
 * How many documented constraints were examined, and how many the project contradicts. The checked
 * figure is the half that matters when nothing is contradicted: it separates a project that was
 * examined and found clean from one nobody looked at.
 */
export type SerialisedConstraints = {
  readonly checked: number;
  readonly contradicted: number;
  /** Framework defaults with no catalog entry to report against, so `checked` covers the whole walk. */
  readonly withoutEntry: number;
  /**
   * Readings a check needed and could not make, each with the reason. Published as objects rather
   * than as a count, for the same reason the text prints them: a consumer comparing `checked`
   * across runs needs to tell a project this tool read less of from a release that checks less.
   * The subject is a configuration option where one was being read, and the name of an installed
   * package where the check rests on a version instead.
   */
  readonly unread: readonly { readonly subject: string; readonly reason: string }[];
};

export type SerialisedContrastFinding = {
  readonly claim: string;
  readonly route: string;
  readonly source: string;
  readonly expected: string;
  readonly recorded: string;
};

/**
 * What the build recorded against the claims this tool derived. Always present: an absent field
 * would merge "no build to read" into "a build that contradicted nothing", which the report prints
 * as two different sentences. `id` is what a consumer branches on, because `claimsChecked` is zero
 * in both.
 */
export type SerialisedBuild = {
  readonly id: string | null;
  /** Why nothing was contrasted. Present exactly when `id` is null. */
  readonly reason?: string;
  readonly claimsChecked: number;
  /** Routes the build had already prerendered, so no suggestion to generate their params stands. */
  readonly withdrawn: number;
  readonly findings: readonly SerialisedContrastFinding[];
  readonly unanswered: {
    /** The build's route mapping has no entry for the route the claim concerns. */
    readonly absentRoute: number;
    /** Recorded as partially prerendered, which settles neither way. */
    readonly undecidedMode: number;
  };
  readonly join: {
    readonly unjoinedRoutes: number;
    readonly metadata: number;
    readonly framework: number;
    readonly unexplained: number;
    readonly disagreements: readonly {
      readonly filePathRoute: string;
      readonly derived: string;
      readonly build: string;
    }[];
  };
};

export type SerialisedRouteWeight = {
  readonly url: string;
  readonly clientModules: number;
  /** First-load bytes as the build recorded them. Absent when there was no figure to join. */
  readonly bytes?: number;
};

export type SerialisedRankedRoute = {
  readonly url: string;
  readonly modules: number;
  readonly bytes: number;
  readonly byModules: number;
  readonly byBytes: number;
  readonly gap: number;
};

/**
 * The client code each route carries, and how far this tool's ordering of it agrees with the one
 * the build recorded. The agreement is a fact about the derivation rather than about the project,
 * which is why it sits beside the routes rather than on each of them.
 */
export type SerialisedWeights = {
  readonly routes: readonly SerialisedRouteWeight[];
  /** Whether the URLs came from the build's own mapping or were derived here. */
  readonly urlSource: string;
  readonly ordering: {
    /** From -1 to 1, or null when fewer than two routes were comparable. */
    readonly agreement: number | null;
    /**
     * The population `agreement` is a proportion of: pairs both orderings place. `compared` is the
     * routes they were drawn from, and reading the figure against that overstates what was counted.
     */
    readonly orderedPairs: number;
    /**
     * What a pair on either side of the agreement is worth, in bytes. A rank correlation counts a
     * pair the same whether the routes differ by a kilobyte or by eight hundred, so without this a
     * low agreement over trivial differences reads like one over large ones. Absent when either
     * side has no pairs.
     */
    readonly separation?: {
      readonly whenDiffering: number;
      readonly whenAgreeing: number;
    };
    /** Why no ordering was contrasted. Present exactly when `agreement` is null. */
    readonly reason?: string;
    readonly compared: number;
    readonly withoutFigure: number;
    /** Every comparable route under both orderings, furthest apart first. */
    readonly ranked: readonly SerialisedRankedRoute[];
  };
};

export type SerialisedReport = {
  readonly schemaVersion: number;
  readonly nextVersion: string;
  readonly preset: string;
  /**
   * Why no surface could be derived, and `null` where one was. The same channel the rendered report
   * prints beneath its summary: without it, a run that read no installed release publishes an empty
   * `entries` and every total at zero, which a program cannot tell from a project the analysis
   * genuinely found nothing to suggest for.
   */
  readonly surfaceUnavailable: string | null;
  readonly projectRoot: string;
  readonly totals: SerialisedTotals;
  readonly constraints: SerialisedConstraints;
  readonly build: SerialisedBuild;
  readonly weights: SerialisedWeights;
  readonly entries: readonly SerialisedEntry[];
};

/**
 * Fields of `CoverageResult` that reach the contract under a different name, or deliberately do
 * not reach it, each with where it went. Every other field is published in `totals` under its own
 * name.
 *
 * The enumeration test reads this: a field added to the internal result and named in neither
 * `totals` nor here fails the suite, rather than becoming a channel nobody notices is missing.
 * That is the check this contract did not have, and its absence is why four channels went
 * unpublished for as long as they did.
 */
export const FIELDS_ACCOUNTED_ELSEWHERE: Readonly<Record<string, string>> = {
  entries: "published as `entries`, entry by entry, rather than as the internal shape",
  preset: "published at the root beside the schema version",
  contrast: "published as `build`, converted",
  weights: "published as `weights.routes`, converted",
  weightContrast: "published as `weights.ordering`, converted",
  constraintsChecked: "published as `constraints.checked`",
  constraintsContradicted: "published as `constraints.contradicted`",
  constraintsWithoutEntry: "published as `constraints.withoutEntry`",
  constraintsUnread: "published as `constraints.unread`",
};

function serialiseSilence(silence: Silence): SerialisedSilence {
  switch (silence.kind) {
    case "abstained":
      return { kind: "abstained", why: silence.why };
    case "examined":
      return { kind: "examined", condition: silence.condition, outcome: silence.outcome };
    case "delegated":
      return { kind: "delegated", to: silence.to };
    case "unwritten":
      return { kind: "unwritten", why: silence.why };
    case "evaluated":
      return { kind: "evaluated" };
  }
}

function serialiseDeclaration(declaration: Declaration): SerialisedDeclaration {
  return { value: declaration.value, files: declaration.files };
}

function serialiseLeak(leak: BoundaryLeak): SerialisedLeak {
  return { module: leak.module, specifier: leak.specifier, chain: leak.chain };
}

/**
 * Field by field rather than by spreading the internal record. The copy is where the decision
 * gets made: a tenth kind, or a renamed field on one of these nine, fails to compile here instead
 * of changing the contract without anyone saying so.
 */
function serialiseConstraint(finding: ConstraintFinding): SerialisedConstraint {
  switch (finding.kind) {
    case "slot-mode":
      return {
        kind: "slot-mode",
        entry: finding.entry,
        segment: finding.segment,
        staticSlots: finding.staticSlots.map((slot) => ({
          slot: slot.slot,
          directory: slot.directory,
        })),
        cause: finding.cause,
        causeChain: finding.causeChain,
        otherDynamic: finding.otherDynamic,
      };
    case "restates-default":
      return {
        kind: "restates-default",
        entry: finding.entry,
        option: finding.option,
        packages: finding.packages,
        whatNextDoes: finding.whatNextDoes,
        source: finding.source,
      };
    case "intercepted-route":
      return {
        kind: "intercepted-route",
        entry: finding.entry,
        option: finding.option,
        routes: finding.routes.map((route) => ({ pattern: route.pattern, serves: route.serves })),
        source: finding.source,
        unread: finding.unread,
      };
    case "unprefixed-asset":
      return {
        kind: "unprefixed-asset",
        entry: finding.entry,
        option: finding.option,
        prefix: finding.prefix,
        assets: finding.assets.map((asset) => ({ file: asset.file, value: asset.value })),
        source: finding.source,
      };
    case "missing-module":
      return {
        kind: "missing-module",
        entry: finding.entry,
        option: finding.option,
        modules: finding.modules.map((module) => ({ value: module.value, as: module.as })),
        source: finding.source,
        unread: finding.unread,
      };
    case "bundler-scope":
      return {
        kind: "bundler-scope",
        entry: finding.entry,
        settings: finding.settings.map((setting) => ({
          option: setting.option,
          ...(setting.value === undefined ? {} : { value: setting.value }),
          scope: setting.scope,
        })),
        running: finding.running,
        source: finding.source,
      };
    case "failing-combination":
      return {
        kind: "failing-combination",
        entry: finding.entry,
        option: finding.option,
        withPackage: finding.withPackage,
        majorInstalled: finding.majorInstalled,
        consequence: finding.consequence,
        source: finding.source,
      };
    case "segment-config-removed":
      return {
        kind: "segment-config-removed",
        entry: finding.entry,
        option: finding.option,
        segments: finding.segments.map((segment) => ({
          file: segment.file,
          exported: segment.exported,
        })),
        consequence: finding.consequence,
        source: finding.source,
      };
    case "absent-prerequisite":
      return {
        kind: "absent-prerequisite",
        entry: finding.entry,
        option: finding.option,
        needs: finding.needs,
        source: finding.source,
      };
  }
}

function serialiseEntry(entry: ClassifiedEntry): SerialisedEntry {
  return {
    id: entry.id,
    domain: entry.domain,
    bucket: entry.bucket,
    evidence: entry.evidence,
    ...(entry.note === undefined ? {} : { note: entry.note }),
    ...(entry.gain === undefined ? {} : { gain: entry.gain }),
    ...(entry.reasons === undefined ? {} : { reasons: entry.reasons }),
    ...(entry.reopenedFrom === undefined ? {} : { reopenedFrom: entry.reopenedFrom }),
    docs: { path: entry.docs.path, url: entry.docs.url },
    ...(entry.silence === undefined ? {} : { silence: serialiseSilence(entry.silence) }),
    ...(entry.skippedForFlag === undefined ? {} : { skippedForFlag: entry.skippedForFlag }),
    ...(entry.needsBuild === undefined ? {} : { needsBuild: entry.needsBuild }),
    ...(entry.alsoWouldApply === undefined
      ? {}
      : {
          alsoWouldApply: {
            ...(entry.alsoWouldApply.note === undefined ? {} : { note: entry.alsoWouldApply.note }),
            gain: entry.alsoWouldApply.gain,
            evidence: entry.alsoWouldApply.evidence,
            ...(entry.alsoWouldApply.reasons === undefined
              ? {}
              : { reasons: entry.alsoWouldApply.reasons }),
          },
        }),
    ...(entry.unmatched === undefined
      ? {}
      : {
          unmatched: {
            note: entry.unmatched.note,
            declarations: entry.unmatched.declarations.map(serialiseDeclaration),
          },
        }),
    ...(entry.leaks === undefined
      ? {}
      : { leaks: { note: entry.leaks.note, items: entry.leaks.items.map(serialiseLeak) } }),
    ...(entry.directivesWithoutReason === undefined
      ? {}
      : {
          directivesWithoutReason: entry.directivesWithoutReason.items.map((found) => ({
            module: found.module,
            exclusiveModules: found.exclusiveModules,
          })),
        }),
    ...(entry.constraints === undefined
      ? {}
      : {
          constraints: {
            note: entry.constraints.note,
            items: entry.constraints.items.map(serialiseConstraint),
          },
        }),
  };
}

function serialiseTotals(result: CoverageResult): SerialisedTotals {
  return {
    used: result.used,
    evaluated: result.evaluated,
    notApplicable: result.notApplicable,
    notEvaluated: result.notEvaluated,
    silence: {
      evaluated: result.silence.evaluated,
      abstained: result.silence.abstained,
      delegated: result.silence.delegated,
      unwritten: result.silence.unwritten,
    },
    skippedForFlag: result.skippedForFlag,
    needingBuild: result.needingBuild,
    partiallyAdopted: result.partiallyAdopted,
    unmatchedDeclarations: result.unmatchedDeclarations,
    unresolvedValues: result.unresolvedValues,
    clientClosure: result.clientClosure,
    placedElsewhere: result.placedElsewhere,
    clientReachedWithoutDeclaring: result.clientReachedWithoutDeclaring,
    ...(result.clientDirectivesWithoutReason === undefined
      ? {}
      : { clientDirectivesWithoutReason: result.clientDirectivesWithoutReason }),
    unresolvedSpecifiers: result.unresolvedSpecifiers,
    ...(result.linkedPackages === undefined ? {} : { linkedPackages: result.linkedPackages }),
    boundaryLeaks: result.boundaryLeaks,
    withheldHeuristics: result.withheldHeuristics,
    conditionsNeedingBuild: result.conditionsNeedingBuild,
    reopenedConditions: result.reopenedConditions,
    restatedConditions: result.restatedConditions,
    verdictsAgainstThisRelease: result.verdictsAgainstThisRelease,
    verdictsAgainstAnOlderRelease: result.verdictsAgainstAnOlderRelease,
    verdictsAgainstANewerRelease: result.verdictsAgainstANewerRelease,
    unwrittenConditions: result.unwrittenConditions,
    unexaminedOptions: result.unexaminedOptions,
    documentedNotCovered: result.documentedNotCovered,
    documentedNotAdoptable: result.documentedNotAdoptable,
    predicatesWithoutSurface: result.predicatesWithoutSurface,
    missingPackages: result.missingPackages.map((missing: MissingPackage) => ({
      name: missing.name,
      declared: missing.declared,
      references: missing.references,
    })),
  };
}

function serialiseBuild(contrast: ContrastReport): SerialisedBuild {
  return {
    id: contrast.buildId ?? null,
    ...(contrast.buildId === undefined ? { reason: contrast.reason ?? "no build was read" } : {}),
    claimsChecked: contrast.checked,
    withdrawn: contrast.withdrawn,
    findings: contrast.findings.map((finding) => ({
      claim: finding.claim,
      route: finding.route,
      source: finding.source,
      expected: finding.expected,
      recorded: finding.recorded,
    })),
    unanswered: {
      absentRoute: contrast.unanswered.absentRoute,
      undecidedMode: contrast.unanswered.undecidedMode,
    },
    join: {
      unjoinedRoutes: contrast.join.unjoinedRoutes,
      metadata: contrast.join.unjoined.metadata,
      framework: contrast.join.unjoined.framework,
      unexplained: contrast.join.unjoined.unexplained,
      disagreements: contrast.join.disagreements.map((disagreement) => ({
        filePathRoute: disagreement.filePathRoute,
        derived: disagreement.derived,
        build: disagreement.build,
      })),
    },
  };
}

function serialiseRanked(route: RankedRoute): SerialisedRankedRoute {
  return {
    url: route.url,
    modules: route.modules,
    bytes: route.bytes,
    byModules: route.byModules,
    byBytes: route.byBytes,
    gap: route.gap,
  };
}

/**
 * The count and the URL, plus the recorded figure where there was one — the three things the
 * report puts on a line. `RouteWeight.modules` is a `ReadonlySet`, which `JSON.stringify` writes
 * as `{}` without complaining, so it is converted to a count here and never published as it stands.
 * Its members are the larger half of the analysis by volume and no reader has ever been shown them.
 */
function serialiseWeights(weights: WeightReport, contrast: WeightContrast): SerialisedWeights {
  const bytesByUrl = new Map(contrast.ranked.map((route) => [route.url, route.bytes]));
  return {
    routes: weights.routes.map((route) => {
      const bytes = bytesByUrl.get(route.url);
      return {
        url: route.url,
        clientModules: route.modules.size,
        ...(bytes === undefined ? {} : { bytes }),
      };
    }),
    urlSource: weights.urlSource,
    ordering: {
      agreement: contrast.agreement ?? null,
      orderedPairs: contrast.orderedPairs,
      ...(contrast.separation === undefined
        ? {}
        : {
            separation: {
              whenDiffering: contrast.separation.whenDiffering,
              whenAgreeing: contrast.separation.whenAgreeing,
            },
          }),
      ...(contrast.agreement === undefined
        ? { reason: contrast.reason ?? "no ordering was contrasted" }
        : {}),
      compared: contrast.compared,
      withoutFigure: contrast.withoutFigure,
      ranked: contrast.ranked.map(serialiseRanked),
    },
  };
}

/**
 * The published shape, authored rather than derived from `CoverageResult`. That type carries
 * twenty-nine fields named for the renderer's benefit, and publishing them would make every one a
 * compatibility surface — a rename made for the report would break every consumer.
 *
 * Every channel the rendered report prints has a field here, because the spec calls the two
 * encodings of one result and a fact reachable in one has to be reachable in the other. What the
 * report does not print stays out: a field no reader has seen is a promise nothing checked.
 *
 * Where the terminal shows the first few of a list, this carries all of them. That limit belongs
 * to the display.
 *
 * Takes the same input as `renderReport` so the two encodings cannot come from different runs.
 */
export function serialiseReport(result: CoverageResult, options: RenderOptions): SerialisedReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    nextVersion: options.version,
    preset: result.preset,
    surfaceUnavailable: options.surfaceUnavailable ?? null,
    projectRoot: options.projectRoot,
    totals: serialiseTotals(result),
    constraints: {
      checked: result.constraintsChecked,
      contradicted: result.constraintsContradicted,
      withoutEntry: result.constraintsWithoutEntry,
      unread: result.constraintsUnread.map((entry) => ({
        subject: entry.subject,
        reason: entry.reason,
      })),
    },
    build: serialiseBuild(result.contrast),
    weights: serialiseWeights(result.weights, result.weightContrast),
    entries: result.entries.map(serialiseEntry),
  };
}
