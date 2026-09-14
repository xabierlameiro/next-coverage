import type { ConstraintReport } from "./constraints.js";
import type { BuildRead, JoinedRoute, RouteJoin } from "./output.js";
import { joinRoutes, prerenderedBySegment, unavailableReason } from "./output.js";
import type { RouteTree } from "./routes.js";
import { dynamicPagesWithoutStaticParams } from "./routes.js";
import type { SourceIndex } from "./sources.js";

/** Which statically derived claim a contrast was drawn against. */
export type ContrastClaim = "slot-prerendering" | "force-static" | "force-dynamic";

/**
 * The route segment config option whose value states what the developer asked the build to do
 * with a route. It is the only rendering-mode claim written in the source rather than derived.
 */
const DYNAMIC_OPTION = "dynamic";
const FORCE_STATIC = "force-static";
const FORCE_DYNAMIC = "force-dynamic";

/**
 * A claim of this tool's set beside what the build recorded for the same route. It reports what
 * the framework produced and what in the source led the tool to expect otherwise. Neither side is
 * called wrong: the project may have chosen this, and from outside that is not knowable.
 */
export type ContrastFinding = {
  readonly claim: ContrastClaim;
  /** The URL the build knows the route by. */
  readonly route: string;
  /** Where in the source the claim was derived from. */
  readonly source: string;
  /** What the tool derived, in words a report can print. */
  readonly expected: string;
  /** What the build recorded, in the same form. */
  readonly recorded: string;
};

export type UnansweredClaims = {
  /** The build's route mapping has no entry for the route the claim concerns. */
  readonly absentRoute: number;
  /** The build recorded partial prerendering, which is neither outcome the claim asks about. */
  readonly undecidedMode: number;
};

export type ContrastReport = {
  readonly findings: readonly ContrastFinding[];
  /** Claims actually contrasted, so an empty report reads as checked rather than absent. */
  readonly checked: number;
  /**
   * Claims the build could not settle, by why. A route the mapping does not list and a route
   * recorded as partially prerendered are different silences: the first is what a manifest does
   * not carry, the second is a property of the route a reader may want to look at.
   */
  readonly unanswered: UnansweredClaims;
  /**
   * Routes a condition would have reported on, that the build had already answered for. Unlike a
   * finding, this is not a disagreement to weigh: the claim was that prerendering did not happen,
   * and the build is what prerenders. Counted so a reader who expected the suggestion can see it
   * was withdrawn rather than never derived.
   */
  readonly withdrawn: number;
  /** The build the statements came from, absent when none was read. */
  readonly buildId?: string;
  /** Why nothing was contrasted, absent when a build was read. */
  readonly reason?: string;
  /** Routes of the tree and entries of the build that did not join, disclosed rather than hidden. */
  readonly join: RouteJoin;
  /**
   * Entries of the build's manifests this tool could not read, so nothing is known about them.
   *
   * Carried to the report because a manifest half-read is not a manifest read, and a silent
   * discard is how a changed manifest goes unnoticed: Next stopped writing `renderingMode` outside
   * PPR and every entry of every build without it was dropped here without a word, which inverted
   * the rendering-mode contrast for as long as nobody looked. A count on the page is what makes
   * the next such change visible in the run rather than in a bug report.
   */
  readonly unreadableEntries: number;
};

export const EMPTY_CONTRAST: ContrastReport = {
  findings: [],
  checked: 0,
  unanswered: { absentRoute: 0, undecidedMode: 0 },
  withdrawn: 0,
  unreadableEntries: 0,
  reason: "no build was read",
  join: {
    routes: [],
    unjoinedRoutes: 0,
    unjoined: { metadata: 0, framework: 0, unexplained: 0 },
    disagreements: [],
  },
};

/**
 * Contrasts the rendering-mode claims this tool derives against what the build recorded.
 *
 * A build that is absent or older than the source draws nothing at all. A finding from a stale
 * build would be a statement about code the developer has already changed, which is exactly the
 * false positive this tool exists without.
 */
export function buildContrast(
  read: BuildRead,
  tree: RouteTree,
  appDirectory: string,
  constraints: ConstraintReport,
  sources: SourceIndex,
  /**
   * Whether the configuration enables an option documented as removing the segment config the
   * mode claims are read from. Passed rather than looked up here: the claim must not be derived
   * even for a segment no constraint reached, so tying it to a finding would make the claim's
   * existence depend on an unrelated join succeeding.
   */
  segmentConfigRemoved: boolean,
  /** The join the caller already built, so the tree is walked once per run rather than twice. */
  joined?: RouteJoin,
): ContrastReport {
  if (read.kind !== "read") {
    return { ...EMPTY_CONTRAST, reason: unavailableReason(read) ?? "no build was read" };
  }

  const join = joined ?? joinRoutes(tree, read.output, appDirectory);
  const bySegment = new Map<string, JoinedRoute>();
  for (const route of join.routes) {
    if (!bySegment.has(route.segment)) bySegment.set(route.segment, route);
  }

  const findings: ContrastFinding[] = [];
  let checked = 0;
  let absentRoute = 0;
  let undecidedMode = 0;

  for (const finding of constraints.findings) {
    // Only the slot-mode claim names routes a build can be asked about. A finding about the
    // configuration has no route to join, and is not a prediction the build can settle.
    if (finding.kind !== "slot-mode") continue;
    for (const slot of finding.staticSlots) {
      const route = bySegment.get(slot.directory);
      if (route === undefined) {
        // A slot carrying only `default.tsx` is not in the build's mapping under any key — the
        // build folds it into the route around it — so there is nothing to join and nothing to ask.
        absentRoute += 1;
        continue;
      }
      if (route.recorded.kind === "not-prerendered") {
        // The build did what the claim said it would. Counted, and nothing to report.
        checked += 1;
        continue;
      }
      if (route.recorded.mode === "PARTIALLY_STATIC" || route.recorded.mode === undefined) {
        // Partial prerendering is neither outcome the claim distinguishes between, so it settles
        // nothing. An unrecorded mode — a build without PPR turned on — is the same silence: it
        // says the route was prerendered but not in which mode, which is exactly what this claim
        // needs an answer to. Saying it agreed would be reading a verdict into an answer that has
        // none.
        undecidedMode += 1;
        continue;
      }
      checked += 1;
      findings.push({
        claim: "slot-prerendering",
        route: route.url,
        source: slot.directory,
        expected: `not prerendered, because @${finding.cause} at the same level is dynamic`,
        recorded: "prerendered in full",
      });
    }
  }

  // A declaration the framework refuses to compile supports no prediction about what a build did
  // with it, and a build that stopped produced no answer to compare against. The claim is not
  // withdrawn after the fact — it is never made, because what would have to be true for it to mean
  // anything is known to be false before the build is consulted. Nothing is counted as unanswered
  // either: an unanswered claim is one a build could have settled.
  for (const route of segmentConfigRemoved ? [] : join.routes) {
    const declared = sources.byPath.get(route.conventionFile)?.exportedLiterals.get(DYNAMIC_OPTION);
    if (declared !== FORCE_STATIC && declared !== FORCE_DYNAMIC) continue;

    const prerendered = route.recorded.kind === "prerendered";
    if (declared === FORCE_STATIC) {
      checked += 1;
      if (prerendered) continue;
      findings.push({
        claim: "force-static",
        route: route.url,
        source: route.conventionFile,
        expected: `prerendered, because the route declares ${DYNAMIC_OPTION} = '${FORCE_STATIC}'`,
        recorded: "among the routes the build did not prerender",
      });
      continue;
    }

    checked += 1;
    if (!prerendered) continue;
    // Whether it was prerendered answers this claim on its own; the mode is extra detail the
    // build only names with PPR turned on, so its absence is reported rather than printed as the
    // literal word "undefined".
    const recorded =
      route.recorded.mode === undefined ? "prerendered" : `prerendered as ${route.recorded.mode}`;
    findings.push({
      claim: "force-dynamic",
      route: route.url,
      source: route.conventionFile,
      expected: `not prerendered, because the route declares ${DYNAMIC_OPTION} = '${FORCE_DYNAMIC}'`,
      recorded,
    });
  }

  // Counted from the same selection the condition reports from, so the figure and the suggestion
  // can never describe different sets of routes.
  const prerenderedSegments = prerenderedBySegment(join);
  const { withdrawn } = dynamicPagesWithoutStaticParams(
    tree,
    (file) => sources.byPath.get(file)?.exportedNames.includes("generateStaticParams") ?? true,
    (segment) => prerenderedSegments.has(segment),
  );

  findings.sort((a, b) => (a.route === b.route ? 0 : a.route < b.route ? -1 : 1));
  return {
    findings,
    checked,
    unanswered: { absentRoute, undecidedMode },
    withdrawn: withdrawn.length,
    buildId: read.output.buildId,
    join,
    unreadableEntries: read.output.unreadableEntries,
  };
}
