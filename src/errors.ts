/**
 * Typed errors, centralised. `class` is used here and nowhere else in the codebase:
 * an Error subclass is the one construct that needs it.
 */

export class DuplicatePredicateError extends Error {
  constructor(readonly id: string) {
    super(`two predicate sets declare the id '${id}'`);
    this.name = "DuplicatePredicateError";
  }
}

/**
 * The release plan holds the BUILD tier back until v4, with one exception: a reopened condition may
 * declare it, because such a condition is strict-only and reads nothing on a project with no build.
 * This is what keeps the exception from widening by being copied onto a predicate nobody refused.
 */
export class PrematureBuildTierError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' declares the BUILD tier without being a reopened condition; the release plan holds ` +
        `that tier until v4, and the exception covers reopened conditions alone`,
    );
    this.name = "PrematureBuildTierError";
  }
}

/**
 * A conversion that deletes the measurement it converted. The refusal is what withholds a reopened
 * condition to the strict preset and what a promotion has to answer, so a predicate replacing one
 * without carrying it is a condition nobody can weigh.
 */
export class DroppedRefusalError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' answered with a refusal and now carries a condition without 'reopenedFrom'; the ` +
        `measurement that refused it is what withholds the condition and what a promotion answers`,
    );
    this.name = "DroppedRefusalError";
  }
}

export class MissingEvidenceError extends Error {
  constructor(
    readonly id: string,
    readonly predicate: string,
  ) {
    super(`'${id}' matched on ${predicate} without evidence; a verdict nobody can check is a bug`);
    this.name = "MissingEvidenceError";
  }
}

export class MissingGainError extends Error {
  constructor(
    readonly id: string,
    readonly predicate: string,
  ) {
    super(
      `'${id}' matched on ${predicate} without saying what adopting buys; a condition that says what it saw and not what it is for is half a recommendation`,
    );
    this.name = "MissingGainError";
  }
}

export class SilentPredicateError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' carries no would-apply condition and no reason for having none; ` +
        "an entry that suggests nothing has to say why",
    );
    this.name = "SilentPredicateError";
  }
}

export class BorrowedReasonError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' is authored but carries the reason the derived option group holds; ` +
        "a reason has to be about the entry that reports it, or it claims an examination " +
        "that never happened",
    );
    this.name = "BorrowedReasonError";
  }
}

export class UnexaminedRefusalError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' is an authored config option that declines to suggest without naming a condition ` +
        "and an outcome; an option taken off the derived group has been examined, and the " +
        "examination is what its entry has to record",
    );
    this.name = "UnexaminedRefusalError";
  }
}

export class DanglingDelegationError extends Error {
  constructor(
    readonly id: string,
    readonly to: string,
  ) {
    super(`'${id}' delegates its suggestion to '${to}', which this version does not document`);
    this.name = "DanglingDelegationError";
  }
}

/**
 * A reason written in the corpus's voice. The register of conditions no referenced project
 * exercises already holds "no project of that shape"; an entry repeating it in its own slot makes
 * the report's ceiling the author's projects rather than the framework's surface, and is false for
 * the first project that holds the shape.
 */
export class CorpusVoiceError extends Error {
  constructor(
    readonly id: string,
    readonly cited: string,
  ) {
    super(
      `'${id}' argues from the corpus rather than from code: its reason cites '${cited}'. ` +
        "A reason says what about a file leaves the question open; which projects hold a shape " +
        "belongs in the silence register, not on the entry",
    );
    this.name = "CorpusVoiceError";
  }
}

/**
 * An examined outcome whose survey answer says the condition found no project. That is the same
 * state as a reason written in the corpus's voice, and it converts the same way: the condition is
 * carried, pinned to a vendored case, and its silence registered.
 */
export class CorpusExaminationError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' records an examination that failed for want of a project, not for want of a rule; ` +
        "a condition that held nowhere is carried and pinned to a vendored case rather than " +
        "abstained on",
    );
    this.name = "CorpusExaminationError";
  }
}

export class UnpromotableConditionError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' carries a default-preset condition and is registered as unpromotable; its ` +
        `objection names a measurement no reading available here can take, so no evidence ` +
        `promotes it`,
    );
    this.name = "UnpromotableConditionError";
  }
}

/**
 * A condition marked as restating the Used bucket, offered in the default preset. Nothing can
 * promote one: any project it fires on is an instance of the objection it was withheld for, so
 * evidence of it firing is evidence for the objection rather than against it.
 */
export class PromotedRestatementError extends Error {
  constructor(id: string) {
    super(
      `${id} is marked as restating the Used bucket and carries a default-preset condition; ` +
        "no evidence can answer an objection every finding is an instance of",
    );
    this.name = "PromotedRestatementError";
  }
}

/**
 * A condition written for an API the reference marks deprecated in its own title. The suggestion
 * would point a reader at something the documentation is steering them away from, which is worse
 * than a guess: it is advice in the wrong direction.
 */
export class DeprecatedOptionConditionError extends Error {
  constructor(id: string) {
    super(
      `${id} carries a condition and its documentation title marks it deprecated; ` +
        "a suggestion here would name an API the reference steers readers away from",
    );
    this.name = "DeprecatedOptionConditionError";
  }
}

export class UnrecordedReopeningError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' carries 'reopenedFrom' and answered with no refusal when the rule changed; a ` +
        `first examination has a measurement of its own to record, not one to reopen`,
    );
    this.name = "UnrecordedReopeningError";
  }
}

export class UsedDetectionBuildTierError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' declares the BUILD tier for its used detection; that decides a bucket under the ` +
        `default preset, so a project with no build would be told nothing about an API its ` +
        `configuration states — a condition may read the build, used detection may not`,
    );
    this.name = "UsedDetectionBuildTierError";
  }
}

export class ConditionCostWithoutConditionError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' declares a cost for a condition it does not carry; a tier for a predicate that ` +
        `does not exist describes nothing and outlives nothing`,
    );
    this.name = "ConditionCostWithoutConditionError";
  }
}

export class GraphTierUnderTheDefaultPresetError extends Error {
  constructor(
    readonly id: string,
    readonly reading: "used detection" | "a default-preset condition",
  ) {
    super(
      `'${id}' would read the module graph from ${reading}, which the default preset runs; a ` +
        `graph reading is available to a strict-preset condition, whose preset decides whether ` +
        `it runs at all, and to one whose reading only narrows what a single read selected`,
    );
    this.name = "GraphTierUnderTheDefaultPresetError";
  }
}

export class NarrowingWithoutGraphTierError extends Error {
  constructor(readonly id: string) {
    super(
      `'${id}' says its graph reading only narrows and declares no graph reading; the mark ` +
        `qualifies a GRAFO condition tier and says nothing without one`,
    );
    this.name = "NarrowingWithoutGraphTierError";
  }
}

export class UnattributedConditionCostError extends Error {
  constructor(
    readonly id: string,
    readonly reason: "no second condition" | "no tier",
  ) {
    super(
      reason === "no tier"
        ? `'${id}' says which condition its tier belongs to without declaring one; there is no ` +
            `reading to attribute`
        : `'${id}' says which of two conditions its tier belongs to and carries only one; the ` +
            `attribution exists to keep a tier from being read as a claim about both`,
    );
    this.name = "UnattributedConditionCostError";
  }
}
