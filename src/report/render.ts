import type { ElsewhereSignal, MissingPackage } from "../collect/sources.js";
import type { StopReason } from "../types.js";
import type { ClassifiedEntry, CoverageResult } from "./classify.js";

export type RenderOptions = {
  readonly colour: boolean;
  readonly version: string;
  readonly projectRoot: string;
  /** Explains why no surface could be derived, when that is the case. */
  readonly surfaceUnavailable?: string;
};

const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

function paint(text: string, code: string, colour: boolean): string {
  return colour ? `${code}${text}${RESET}` : text;
}

/**
 * A count with the wording its own value asks for. The two forms carry whatever has to agree with
 * the number — the noun, and the verb where one follows it — because a report that says `1 files
 * are newer` reads as a formatting bug and invites the reader to doubt the figure beside it.
 */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The files of a verdict composed from several conditions, each under its own sentence. Printed in
 * place of the flat list, which cites the same files without saying which sentence each one is for.
 */
function renderReasons(
  reasons: NonNullable<ClassifiedEntry["reasons"]>,
  indent: string,
  options: RenderOptions,
): string[] {
  const lines: string[] = [];
  for (const reason of reasons) {
    lines.push(`${indent}${paint(reason.note, DIM, options.colour)}`);
    for (const path of reason.evidence.slice(0, 3)) {
      lines.push(`${indent}  ${paint(path, DIM, options.colour)}`);
    }
    if (reason.evidence.length > 3) {
      const rest = `and ${reason.evidence.length - 3} more`;
      lines.push(`${indent}  ${paint(rest, DIM, options.colour)}`);
    }
  }
  return lines;
}

/** The two lines beneath a suggestion: what adopting buys, then the page that documents it. */
function renderArgument(gain: string, url: string, options: RenderOptions): string[] {
  return [`      ${paint(gain, DIM, options.colour)}`, `      ${paint(url, DIM, options.colour)}`];
}

/**
 * The line beneath a reopened condition: the verdict that once stood where it argues. It is why the
 * finding is withheld by default, so a reader who has asked for it with `--strict` is told what
 * they are looking at rather than left to weigh it blind.
 *
 * The two verdicts read differently on purpose. *Once refused* says somebody tried a condition and
 * measured it as arguing nothing; *once abstained* says somebody decided the question is not one a
 * codebase answers. A reader weighing a strict finding is owed the difference.
 */
function renderReopening(
  reopened: ClassifiedEntry["reopenedFrom"],
  options: RenderOptions,
): string[] {
  if (reopened === undefined) return [];
  const sentence =
    reopened.from === undefined
      ? `once refused: ${reopened.condition}, and ${reopened.outcome}`
      : `once abstained: ${reopened.why}`;
  return [`      ${paint(sentence, DIM, options.colour)}`];
}

const BUCKET_TITLES = {
  used: "Used",
  "would-apply": "Would apply",
  "not-applicable": "Not applicable",
  "not-evaluated": "Not evaluated",
} as const;

function renderGroup(
  entries: readonly ClassifiedEntry[],
  options: RenderOptions,
  showEvidence: boolean,
): string[] {
  const lines: string[] = [];
  let domain = "";
  for (const entry of entries) {
    if (entry.domain !== domain) {
      domain = entry.domain;
      lines.push(`  ${paint(domain, DIM, options.colour)}`);
    }
    const suffix = entry.note ? ` ${paint(`— ${entry.note}`, DIM, options.colour)}` : "";
    lines.push(`    ${entry.title}${suffix}`);
    // The gain completes the note's sentence; the page is where to go next; the evidence, printed
    // last, is what to look at. A used entry with nothing to suggest prints neither line: a page
    // reference on an API the project already uses is a line nobody asked for.
    if (entry.gain !== undefined) {
      lines.push(...renderArgument(entry.gain, entry.docs.url, options));
      lines.push(...renderReopening(entry.reopenedFrom, options));
    }
    if (entry.unmatched) {
      const { note, declarations } = entry.unmatched;
      lines.push(`      ${paint(note, DIM, options.colour)}`);
      for (const declaration of declarations.slice(0, 6)) {
        const where = declaration.files[0] ?? "";
        lines.push(`        ${declaration.value} ${paint(where, DIM, options.colour)}`);
      }
      if (declarations.length > 6) {
        const rest = `and ${declarations.length - 6} more`;
        lines.push(`        ${paint(rest, DIM, options.colour)}`);
      }
    }
    if (entry.leaks) {
      const { note, items } = entry.leaks;
      lines.push(`      ${paint(note, DIM, options.colour)}`);
      for (const leak of items.slice(0, 6)) {
        lines.push(
          `        ${leak.module} ${paint(`imports ${leak.specifier}`, DIM, options.colour)}`,
        );
        // The chain is what lets a reader judge the finding, a barrel in the middle included.
        if (leak.chain.length > 1) {
          lines.push(`          ${paint(leak.chain.join(" → "), DIM, options.colour)}`);
        }
      }
      if (items.length > 6) {
        lines.push(`        ${paint(`and ${items.length - 6} more`, DIM, options.colour)}`);
      }
    }
    // An examination that ran and found nothing prints nothing here: the summary already says it
    // ran, and a heading over an empty list reads as a finding withheld.
    if (entry.directivesWithoutReason && entry.directivesWithoutReason.items.length > 0) {
      const { note, items } = entry.directivesWithoutReason;
      lines.push(`      ${paint(note, DIM, options.colour)}`);
      for (const found of items.slice(0, 6)) {
        // A count of modules, never a weight: what leaves a bundle is the build's to say.
        const carries = plural(found.exclusiveModules, "module reaches", "modules reach");
        lines.push(
          `        ${found.module} ${paint(`${carries} the client only through it`, DIM, options.colour)}`,
        );
      }
      if (items.length > 6) {
        lines.push(`        ${paint(`and ${items.length - 6} more`, DIM, options.colour)}`);
      }
    }
    if (entry.constraints) {
      const { note, items } = entry.constraints;
      lines.push(`      ${paint(note, DIM, options.colour)}`);
      for (const finding of items) {
        if (finding.kind === "restates-default") {
          // What the framework does, and the packages it does it to. Not that the line is
          // redundant: a project may pin one against a release dropping it from the default.
          const names = finding.packages.join(", ");
          lines.push(
            `        ${finding.option} ${paint(`names ${names}, which ${finding.whatNextDoes} by default`, DIM, options.colour)}`,
          );
          continue;
        }
        if (finding.kind === "intercepted-route") {
          // The path, and the file that answers requests there. Not that either is wrong: a
          // project may be retiring the route and have left the file where it was.
          for (const route of finding.routes) {
            lines.push(
              `        ${route.pattern} ${paint(`is routed away by ${finding.option}, so ${route.serves} is not reached`, DIM, options.colour)}`,
            );
          }
          if (finding.unread > 0) {
            const rules = finding.unread === 1 ? "rule" : "rules";
            lines.push(
              `        ${paint(`${finding.unread} ${rules} could not be read, so this is what was legible`, DIM, options.colour)}`,
            );
          }
          continue;
        }
        if (finding.kind === "unprefixed-asset") {
          // The value the documentation asks for, and the sources written without it. Not that
          // they are wrong: a project may serve those paths through a rewrite of its own.
          for (const asset of finding.assets) {
            lines.push(
              `        ${asset.value} ${paint(`in ${asset.file} carries no ${finding.option}, so it is requested without ${finding.prefix}`, DIM, options.colour)}`,
            );
          }
          continue;
        }
        if (finding.kind === "missing-module") {
          // The entry and how it was looked for, so a reader can see which resolution was tried.
          for (const module of finding.modules) {
            const how =
              module.as === "path"
                ? "no file under the project root"
                : "not a declared or installed package";
            lines.push(
              `        ${module.value} ${paint(`is imported by ${finding.option}, and is ${how}`, DIM, options.colour)}`,
            );
          }
          if (finding.unread > 0) {
            const entries = finding.unread === 1 ? "entry" : "entries";
            lines.push(
              `        ${paint(`${finding.unread} ${entries} could not be read, so this is what was legible`, DIM, options.colour)}`,
            );
          }
          continue;
        }
        if (finding.kind === "bundler-scope") {
          // The setting, what its page scopes it to, and what the scripts run. Not that the line
          // is wrong: a project may be keeping it for a bundler it means to return to.
          const running = finding.running.join(" and ");
          for (const setting of finding.settings) {
            const named =
              setting.value === undefined
                ? setting.option
                : `${setting.option}: '${setting.value}'`;
            lines.push(
              `        ${named} ${paint(`is documented for ${setting.scope}, and the scripts run ${running}`, DIM, options.colour)}`,
            );
          }
          continue;
        }
        if (finding.kind === "failing-combination") {
          // The setting, the version it meets, and what the page says happens. Not that the
          // configuration is wrong: a project mid-migration may be holding it knowingly.
          lines.push(
            `        ${finding.option} ${paint(`is off with ${finding.withPackage} ${finding.majorInstalled} installed, and ${finding.consequence}`, DIM, options.colour)}`,
          );
          continue;
        }
        if (finding.kind === "segment-config-removed") {
          // What the option removed and where the project still exports it. Not that the segment is
          // wrong: a project part-way through this migration holds the combination knowingly.
          lines.push(
            `        ${finding.option} ${paint(`is on, and ${finding.consequence}`, DIM, options.colour)}`,
          );
          for (const segment of finding.segments.slice(0, 3)) {
            lines.push(
              `          ${paint(`${segment.file} exports ${segment.exported}`, DIM, options.colour)}`,
            );
          }
          if (finding.segments.length > 3) {
            lines.push(
              `          ${paint(`and ${finding.segments.length - 3} more`, DIM, options.colour)}`,
            );
          }
          continue;
        }
        if (finding.kind === "absent-prerequisite") {
          // What the option governs and what it needs. Not that it is wrong: a project may be
          // configuring ahead of a file it is about to add.
          lines.push(
            `        ${finding.option} ${paint(`needs ${finding.needs}`, DIM, options.colour)}`,
          );
          continue;
        }
        const slots = finding.staticSlots.map((slot) => `@${slot.slot}`).join(", ");
        const others = finding.otherDynamic > 0 ? ` and ${finding.otherDynamic} more` : "";
        lines.push(
          `        ${finding.segment} ${paint(`${slots} beside @${finding.cause}${others}`, DIM, options.colour)}`,
        );
        // A chain of one means the slot's own file decided it, so there is nothing to follow.
        if (finding.causeChain.length > 1) {
          lines.push(`          ${paint(finding.causeChain.join(" → "), DIM, options.colour)}`);
        }
      }
    }
    if (entry.alsoWouldApply) {
      const also = entry.alsoWouldApply;
      const where = `also applies in ${also.evidence.length} more`;
      const why = also.note ? `: ${also.note}` : "";
      lines.push(`      ${paint(`${where}${why}`, DIM, options.colour)}`);
      lines.push(...renderArgument(also.gain, entry.docs.url, options).map((line) => `  ${line}`));
      if (also.reasons !== undefined) {
        lines.push(...renderReasons(also.reasons, "        ", options));
      } else {
        for (const path of also.evidence.slice(0, 3)) {
          lines.push(`        ${paint(path, DIM, options.colour)}`);
        }
      }
    }
    if (showEvidence && entry.reasons !== undefined) {
      lines.push(...renderReasons(entry.reasons, "      ", options));
    } else if (showEvidence) {
      for (const path of entry.evidence.slice(0, 3)) {
        lines.push(`      ${paint(path, DIM, options.colour)}`);
      }
      if (entry.evidence.length > 3) {
        const rest = `      ${paint(`and ${entry.evidence.length - 3} more`, DIM, options.colour)}`;
        lines.push(rest);
      }
    }
  }
  return lines;
}

/**
 * What the project's own build did with the claims this tool derived from its source. Rendered
 * beside the buckets and never as a fourth one: adoption is about adoption, and a contrast moves
 * nothing between them. The section appears even when it found nothing, because one that goes
 * silent on an empty result is indistinguishable from one that did not run.
 */
function renderContrast(result: CoverageResult, options: RenderOptions): string[] {
  const { contrast } = result;
  const lines = [`${paint("Build contrast", BOLD, options.colour)}`];

  if (contrast.buildId === undefined) {
    const reason = contrast.reason ?? "no build was read";
    lines.push(`  ${paint(`nothing contrasted: ${reason}`, DIM, options.colour)}`);
    lines.push("");
    return lines;
  }

  // Zero checked is not agreement. Saying the build agreed with nothing would read as a verdict
  // where there was no question, which is the one thing this channel must not do.
  const verdict =
    contrast.checked === 0
      ? "no rendering-mode claim reached it"
      : contrast.findings.length === 0
        ? // What the build agreed with counts too, so it goes inside the pair: one claim left
          // "1 rendering-mode claim checked, the build agreed with all of them".
          plural(
            contrast.checked,
            "rendering-mode claim checked, and the build agreed with it",
            "rendering-mode claims checked, and the build agreed with all of them",
          )
        : `${plural(contrast.checked, "rendering-mode claim", "rendering-mode claims")} checked, ${contrast.findings.length} disagreed`;
  lines.push(`  ${paint(`build ${contrast.buildId}: ${verdict}`, DIM, options.colour)}`);

  for (const finding of contrast.findings) {
    lines.push(`    ${finding.route} ${paint(finding.source, DIM, options.colour)}`);
    lines.push(`      ${paint(`expected ${finding.expected}`, DIM, options.colour)}`);
    lines.push(`      ${paint(`the build recorded it ${finding.recorded}`, DIM, options.colour)}`);
  }

  const notes: string[] = [];
  // Printed first, because it is the one note that says the reading itself was incomplete rather
  // than that a question had no answer. A manifest half-read is not a manifest read, and a silent
  // discard is how a changed manifest goes unnoticed for a release or two.
  if (contrast.unreadableEntries > 0) {
    notes.push(
      plural(
        contrast.unreadableEntries,
        "entry of the build's manifests was written in a shape this tool does not read",
        "entries of the build's manifests were written in a shape this tool does not read",
      ),
    );
  }
  if (contrast.withdrawn > 0) {
    notes.push(
      `${plural(contrast.withdrawn, "route", "routes")} the build prerendered, so no suggestion to generate params stands`,
    );
  }
  const { absentRoute, undecidedMode } = contrast.unanswered;
  if (absentRoute > 0) {
    notes.push(
      `${plural(absentRoute, "claim", "claims")} about a route the build's own mapping does not list`,
    );
  }
  if (undecidedMode > 0) {
    notes.push(
      `${plural(undecidedMode, "claim", "claims")} the build answered with partial prerendering, which settles neither way`,
    );
  }
  const { unjoinedRoutes, unjoined, disagreements } = contrast.join;
  if (unjoinedRoutes > 0) {
    notes.push(`${plural(unjoinedRoutes, "route", "routes")} the build does not mention`);
  }
  if (unjoined.unexplained > 0) {
    notes.push(
      `${plural(unjoined.unexplained, "route", "routes")} of its own this tool did not claim`,
    );
  }
  // Located and not joined, which is not the same as unseen. Stated so the reader knows the
  // difference between what the tool cannot claim and what it claims under another name.
  if (unjoined.metadata > 0) {
    // The pronoun and the key agree with the count too, so both belong inside the pair rather
    // than trailing it: one route left "1 metadata route it serves under their own keys".
    notes.push(
      plural(
        unjoined.metadata,
        "metadata route it serves under a key of its own",
        "metadata routes it serves under keys of their own",
      ),
    );
  }
  if (unjoined.framework > 0) {
    notes.push(
      `${plural(unjoined.framework, "route", "routes")} Next.js generates rather than the project`,
    );
  }
  if (disagreements.length > 0) {
    notes.push(
      `${plural(disagreements.length, "route", "routes")} whose URL this tool derived differently`,
    );
  }
  for (const note of notes) lines.push(`  ${paint(note, DIM, options.colour)}`);
  lines.push("");
  return lines;
}

/** How many routes the weight section names before it starts counting the rest. */
const WEIGHT_ROWS = 5;

/**
 * What each route puts on the client, and how far that ordering agrees with the one the build
 * recorded. The counts are derived from source, so this section appears with no build at all; only
 * the agreement needs one.
 *
 * It states counts and never a judgement. There is no threshold here and no route is called heavy:
 * how much client code a route should carry is not this tool's opinion to have.
 */
function renderWeights(result: CoverageResult, options: RenderOptions): string[] {
  const { weights, weightContrast } = result;
  if (weights.routes.length === 0) return [];

  const lines = [`${paint("Client weight", BOLD, options.colour)}`];
  const kilobytes = (bytes: number): string => `${Math.round(bytes / 1024)} kB`;
  const bytesOf = (url: string): string => {
    const row = weightContrast.ranked.find((route) => route.url === url);
    return row === undefined
      ? ""
      : ` · ${Math.round(row.bytes / 1024)} kB first load, per the build`;
  };
  for (const route of weights.routes.slice(0, WEIGHT_ROWS)) {
    const count = plural(route.modules.size, "client module", "client modules");
    lines.push(`  ${route.url} ${paint(`${count}${bytesOf(route.url)}`, DIM, options.colour)}`);
  }
  if (weights.routes.length > WEIGHT_ROWS) {
    const rest = `and ${weights.routes.length - WEIGHT_ROWS} more routes`;
    lines.push(`  ${paint(rest, DIM, options.colour)}`);
  }

  if (weightContrast.agreement === undefined) {
    const reason = weightContrast.reason ?? "no ordering was contrasted";
    lines.push(`  ${paint(`no ordering contrasted: ${reason}`, DIM, options.colour)}`);
    lines.push("");
    return lines;
  }

  // The figure is about this tool's derivation, and the wording has to carry that: a low
  // agreement means a module count is a poor proxy here, not that the routes are wrong.
  //
  // It names the pairs rather than the routes because it is a proportion of pairs. Reading it as
  // a proportion of routes overstates what was counted, and the earlier wording invited that.
  const percent = Math.round(weightContrast.agreement * 100);
  const summary = `this tool's ordering agrees with the build's on ${percent}% of the ${plural(weightContrast.orderedPairs, "route pair", "route pairs")} both orderings place, across ${plural(weightContrast.compared, "route", "routes")}`;
  lines.push(`  ${paint(summary, DIM, options.colour)}`);
  // What the figure cannot say on its own: a pair counts the same whether the two routes differ
  // by a kilobyte or by eight hundred. Without this, an ordering wrong about routes that are
  // nearly the same weight reads exactly like one wrong about routes that are not.
  if (weightContrast.separation !== undefined) {
    const { whenDiffering, whenAgreeing } = weightContrast.separation;
    const note = `the pairs it places differently are ${kilobytes(whenDiffering)} apart, against ${kilobytes(whenAgreeing)} for the pairs it agrees on`;
    lines.push(`  ${paint(note, DIM, options.colour)}`);
  }
  if (weightContrast.withoutFigure > 0) {
    const note = `${plural(weightContrast.withoutFigure, "route carries", "routes carry")} no recorded figure`;
    lines.push(`  ${paint(note, DIM, options.colour)}`);
  }
  for (const route of weightContrast.furthest.slice(0, WEIGHT_ROWS)) {
    const where = `${route.byModules} by modules, ${route.byBytes} by bytes`;
    lines.push(`    ${route.url} ${paint(where, DIM, options.colour)}`);
  }
  if (weightContrast.furthest.length > WEIGHT_ROWS) {
    const rest = `and ${weightContrast.furthest.length - WEIGHT_ROWS} more placed differently`;
    lines.push(`    ${paint(rest, DIM, options.colour)}`);
  }
  lines.push("");
  return lines;
}

/** Describes the surface. It never scores, warns or fails. */
export function renderReport(result: CoverageResult, options: RenderOptions): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `${paint("next-coverage", BOLD, options.colour)} ${paint(
      `· Next.js ${options.version} · ${options.projectRoot}`,
      DIM,
      options.colour,
    )}`,
  );
  lines.push("");

  if (options.surfaceUnavailable) {
    lines.push(`  Surface could not be derived: ${options.surfaceUnavailable}`);
    lines.push("");
    return lines.join("\n");
  }

  for (const bucket of ["would-apply", "used", "not-applicable"] as const) {
    const entries = result.entries.filter((entry) => entry.bucket === bucket);
    if (entries.length === 0) continue;
    lines.push(`${paint(BUCKET_TITLES[bucket], BOLD, options.colour)} (${entries.length})`);
    lines.push(...renderGroup(entries, options, bucket !== "not-applicable"));
    lines.push("");
  }

  lines.push(...renderContrast(result, options));
  lines.push(...renderWeights(result, options));

  if (result.evaluated === 0) {
    lines.push("  Nothing could be evaluated, so no ratio is shown.");
  } else {
    lines.push(`  ${result.used} of ${result.evaluated} evaluated APIs are in use.`);
  }

  const notes: string[] = [];
  if (result.skippedForFlag > 0) {
    notes.push(`${result.skippedForFlag} skipped because a config flag is off or unresolved`);
  }
  if (result.needingBuild > 0) {
    notes.push(`${result.needingBuild} skipped because there is no build to read them against`);
  }
  const withoutVerdict = result.notEvaluated - result.skippedForFlag - result.needingBuild;
  if (withoutVerdict > 0) {
    notes.push(`${withoutVerdict} had no verdict${silenceBreakdown(result)}`);
  }
  if (result.partiallyAdopted > 0) {
    notes.push(`${result.partiallyAdopted} used in some places and missing in others`);
  }
  if (result.unmatchedDeclarations > 0) {
    notes.push(
      `${plural(result.unmatchedDeclarations, "declaration", "declarations")} with no counterpart elsewhere`,
    );
  }
  if (result.unresolvedValues > 0) {
    notes.push(
      `${plural(result.unresolvedValues, "value could", "values could")} not be read, so matching is not exhaustive`,
    );
  }
  if (result.clientClosure > 0) {
    notes.push(
      `${plural(result.clientClosure, "file is", "files are")} on the client side of the boundary, ${result.clientReachedWithoutDeclaring} of them without declaring it`,
    );
  }
  // Named one signal at a time: "36 files set aside" and "36 tests nobody was recognising" are
  // different facts about a project, and a reader whose script stopped being mentioned wants the
  // second. Silent at zero, because a signal that fired nowhere is not a finding.
  const elsewhere = Object.entries(result.placedElsewhere)
    .filter((entry): entry is [ElsewhereSignal, number] => entry[1] > 0)
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
  if (elsewhere.length > 0) {
    const total = elsewhere.reduce((sum, [, count]) => sum + count, 0);
    const named = elsewhere.map(([signal, count]) => `${count} ${ELSEWHERE_PROSE[signal]}`);
    notes.push(
      `${plural(total, "file runs", "files run")} somewhere other than the Next.js server, so no server-side condition reports on them — ${named.join(", ")}`,
    );
  }
  // Beside the closure size, so the two figures are read together: how much is on the client, and
  // how much of it a file put there while showing no reason for the side it chose. Stated at zero
  // too, on the rule the other examinations follow — a figure left unsaid is a claim nobody checks.
  if (result.clientDirectivesWithoutReason !== undefined) {
    notes.push(
      `${plural(result.clientDirectivesWithoutReason, "client entry declares the directive and shows", "client entries declare the directive and show")} none of the documented reasons for it`,
    );
  }
  const linked = result.linkedPackages;
  if (linked !== undefined && linked.scanned > 0) {
    notes.push(
      `${plural(linked.scanned, "linked workspace package was", "linked workspace packages were")} read as part of this project`,
    );
  }
  if (linked !== undefined && linked.unmatched > 0) {
    notes.push(
      `${plural(linked.unmatched, "workspace dependency names", "workspace dependencies name")} no member of the workspace, so their code was not read`,
    );
  }
  if (result.unresolvedSpecifiers > 0) {
    notes.push(
      `${plural(result.unresolvedSpecifiers, "import could", "imports could")} not be resolved, so that boundary is not exhaustive`,
    );
  }
  const missing = missingPackagesNote(result.missingPackages);
  if (missing !== undefined) notes.push(missing);
  if (result.constraintsChecked > 0) {
    const verdict =
      result.constraintsContradicted === 0
        ? "none contradicted"
        : `${result.constraintsContradicted} contradicted`;
    notes.push(
      `${plural(result.constraintsChecked, "documented constraint", "documented constraints")} checked, ${verdict}`,
    );
  }
  // Why that figure is the figure. One line per option, because the reason already names it and a
  // count would restate the very thing this exists to stop being the whole answer: a check that
  // could not run lowers the number above and, without this, says nothing else at all.
  for (const { reason } of result.constraintsUnread) {
    notes.push(`a documented constraint went unchecked: ${reason}`);
  }
  // What the comparison walked past. Stated at zero too, on the rule the backlog and the
  // remainder follow: a figure left unsaid is a claim that cannot fail.
  notes.push(
    result.constraintsWithoutEntry === 0
      ? "every framework default has an option page to report against"
      : `${plural(result.constraintsWithoutEntry, "framework default has", "framework defaults have")} no option page to report against`,
  );
  if (result.withheldHeuristics > 0) {
    notes.push(
      `${plural(result.withheldHeuristics, "opt-in suggestion", "opt-in suggestions")} withheld; run with --strict to see them`,
    );
  }
  if (result.conditionsNeedingBuild > 0) {
    notes.push(
      `${plural(result.conditionsNeedingBuild, "condition", "conditions")} could not run because there is no build to read them against`,
    );
  }
  // Beside the withheld count because it qualifies it: a reopened condition is withheld for a
  // reason of its own, and a reader weighing the strict preset is owed how much of it is that.
  if (result.reopenedConditions > 0) {
    notes.push(
      `${plural(result.reopenedConditions, "condition argues", "conditions argue")} from a shape a measurement refused`,
    );
  }
  // The figure that qualifies the one above it. A reopened condition may still say something; one
  // of these says only that the API is unused, which is the Used bucket read backwards. A reader
  // who finds the strict preset useless should learn why here rather than by reading every entry.
  if (result.restatedConditions > 0) {
    notes.push(
      `${plural(result.restatedConditions, "of those says", "of those say")} only that the API is unused`,
    );
  }
  // Bookkeeping rather than a finding, and it stays quiet when there is none: a verdict read
  // against an older release says the maintainer has not re-opened that page, which is a fact
  // about this tool and never about the project it is reading.
  if (result.verdictsAgainstAnOlderRelease > 0) {
    notes.push(
      `${plural(result.verdictsAgainstAnOlderRelease, "verdict was", "verdicts were")} measured against an older release than the one installed`,
    );
  }
  // The mirror, and a different fact: the reading was made against pages this project has not
  // reached yet. Said separately because the sentence above named a direction it could not know.
  if (result.verdictsAgainstANewerRelease > 0) {
    notes.push(
      `${plural(result.verdictsAgainstANewerRelease, "verdict was", "verdicts were")} measured against a newer release than the one installed`,
    );
  }
  if (result.documentedNotCovered > 0) {
    notes.push(
      `${plural(result.documentedNotCovered, "documented API", "documented APIs")} this tool cannot detect yet`,
    );
  }
  // A gap in what this tool can argue, not a finding about the project. Stated either way: a
  // backlog of zero is a claim that can fail, and one asserted from memory already had.
  notes.push(
    result.unwrittenConditions === 0
      ? "no API is left with a condition believed to exist and unwritten"
      : `${plural(result.unwrittenConditions, "API carries", "APIs carry")} a condition believed to exist and not yet written`,
  );
  // The same shape as the backlog above, and for the same reason: a remainder of zero is a claim
  // that can fail. Phrased as pages nobody has looked at, never as a share of anything — it counts
  // this tool's own unexamined work, and a ratio here would read as a grade for the project.
  notes.push(
    result.unexaminedOptions === 0
      ? "every documented config option has been examined one at a time"
      : `${plural(result.unexaminedOptions, "config option has", "config options have")} not been examined one at a time`,
  );
  if (result.predicatesWithoutSurface.length > 0) {
    // Named, not counted. These are the entries a reader cannot find any other way: with no
    // documented page there is no entry, and with no entry the API is absent from every bucket —
    // so a project using one reads a report that never mentions the file it wrote.
    //
    // One per line rather than joined onto the note. A project on the release before the current
    // one carries sixteen of these, and sixteen ids run together wrap into a paragraph nobody
    // scans for their own — which is the reading this disclosure exists to allow.
    notes.push(
      `${plural(result.predicatesWithoutSurface.length, "API this tool detects is", "APIs this tool detects are")} not documented by this version:`,
    );
    for (const id of result.predicatesWithoutSurface) notes.push(`  ${id}`);
  }
  if (result.documentedNotAdoptable > 0) {
    notes.push(
      `${plural(result.documentedNotAdoptable, "documented page", "documented pages")} excluded: ` +
        `${result.documentedNotAdoptable === 1 ? "it covers" : "they cover"} extending or ` +
        `operating Next.js, not an API a project adopts`,
    );
  }
  for (const note of notes) lines.push(`  ${paint(note, DIM, options.colour)}`);

  lines.push("");
  return lines.join("\n");
}

/**
 * The optional fields of a `ClassifiedEntry` that carry something the run found, as opposed to
 * where an API appears. Named as a value rather than read off the type so a fifth channel added to
 * `ClassifiedEntry` fails a test here instead of being dropped from the findings view in silence.
 */
/** What each signal is, in the words the summary uses. */
const ELSEWHERE_PROSE: Readonly<Record<ElsewhereSignal, string>> = {
  "public-asset": "served from the public directory",
  "service-worker": "in a service worker",
  "pages-router": "importing from next/router",
  "node-script": "in a script Node runs",
  "tool-config": "configuring a build or test tool",
};

export const FINDING_CHANNELS = ["alsoWouldApply", "unmatched", "leaks", "constraints"] as const;

/**
 * Whether an entry has anything to say about this project beyond where an API appears.
 *
 * The whole would-apply bucket qualifies: it exists to name what the project could adopt. Every
 * other bucket qualifies only through a channel, because an entry with no channel says the project
 * uses an API, which is the inventory and not a finding.
 */
export function hasFinding(entry: ClassifiedEntry): boolean {
  if (entry.bucket === "would-apply") return true;
  return FINDING_CHANNELS.some((channel) => entry[channel] !== undefined);
}

/**
 * The same run, rendered down to what it found. A filter over the lines `renderReport` would print
 * and never a second formatter: both go through `renderGroup`, so a finding cannot reach a reader
 * worded two ways depending on which flag they passed.
 *
 * What it drops is what states no finding — the used inventory, the evidence under a used entry,
 * not-applicable, and the client weight, which reports counts and by design never a judgement. What
 * it keeps beyond the findings is the disclosure of its own shortening: a view that shrinks
 * silently reports having found nothing and having barely looked as the same output.
 */
export function renderFindings(result: CoverageResult, options: RenderOptions): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `${paint("next-coverage", BOLD, options.colour)} ${paint(
      `· Next.js ${options.version} · ${options.projectRoot} · findings only`,
      DIM,
      options.colour,
    )}`,
  );
  lines.push("");

  if (options.surfaceUnavailable) {
    lines.push(`  Surface could not be derived: ${options.surfaceUnavailable}`);
    lines.push("");
    return lines.join("\n");
  }

  const found = result.entries.filter(hasFinding);
  const wouldApply = found.filter((entry) => entry.bucket === "would-apply");
  // Everything else got in through a channel, so the channel is the finding and the evidence
  // underneath it is the inventory this view exists to leave out.
  const attached = found.filter((entry) => entry.bucket !== "would-apply");

  if (wouldApply.length > 0) {
    lines.push(
      `${paint(BUCKET_TITLES["would-apply"], BOLD, options.colour)} (${wouldApply.length})`,
    );
    lines.push(...renderGroup(wouldApply, options, true));
    lines.push("");
  }
  if (attached.length > 0) {
    lines.push(`${paint("Findings on APIs in use", BOLD, options.colour)} (${attached.length})`);
    lines.push(...renderGroup(attached, options, false));
    lines.push("");
  }

  lines.push(...renderContrast(result, options));

  const silent = result.entries.length - found.length;
  const notes: string[] = [];
  notes.push(
    found.length === 0
      ? `no entry carries a finding, of ${plural(result.entries.length, "entry examined", "entries examined")}`
      : `${plural(found.length, "entry carries", "entries carry")} a finding, of ${result.entries.length} examined`,
  );
  if (silent > 0) {
    notes.push(
      `${plural(silent, "entry is", "entries are")} not printed here: nothing is attached to them`,
    );
  }
  // Kept for the same reason as the withheld-heuristics line below: it says the run read less than
  // the project holds, which changes what an entry reporting nothing means. The count of packages
  // that *were* read is informative rather than a limitation, so it stays in the full report.
  if (result.linkedPackages !== undefined && result.linkedPackages.unmatched > 0) {
    notes.push(
      `${plural(result.linkedPackages.unmatched, "workspace dependency names", "workspace dependencies name")} no member of the workspace, so their code was not read`,
    );
  }
  // Kept from the full report's footer because it is the one disclosure about something the run
  // deliberately did not do. Dropping it here would let a preset hide suggestions behind a flag.
  if (result.withheldHeuristics > 0) {
    notes.push(
      `${plural(result.withheldHeuristics, "opt-in suggestion", "opt-in suggestions")} withheld; run with --strict to see them`,
    );
  }
  if (result.conditionsNeedingBuild > 0) {
    notes.push(
      `${plural(result.conditionsNeedingBuild, "condition", "conditions")} could not run because there is no build to read them against`,
    );
  }
  if (result.reopenedConditions > 0) {
    notes.push(
      `${plural(result.reopenedConditions, "condition argues", "conditions argue")} from a shape a measurement refused`,
    );
  }
  // The figure that qualifies the one above it. A reopened condition may still say something; one
  // of these says only that the API is unused, which is the Used bucket read backwards. A reader
  // who finds the strict preset useless should learn why here rather than by reading every entry.
  if (result.restatedConditions > 0) {
    notes.push(
      `${plural(result.restatedConditions, "of those says", "of those say")} only that the API is unused`,
    );
  }
  // Bookkeeping rather than a finding, and it stays quiet when there is none: a verdict read
  // against an older release says the maintainer has not re-opened that page, which is a fact
  // about this tool and never about the project it is reading.
  if (result.verdictsAgainstAnOlderRelease > 0) {
    notes.push(
      `${plural(result.verdictsAgainstAnOlderRelease, "verdict was", "verdicts were")} measured against an older release than the one installed`,
    );
  }
  // The mirror, and a different fact: the reading was made against pages this project has not
  // reached yet. Said separately because the sentence above named a direction it could not know.
  if (result.verdictsAgainstANewerRelease > 0) {
    notes.push(
      `${plural(result.verdictsAgainstANewerRelease, "verdict was", "verdicts were")} measured against a newer release than the one installed`,
    );
  }
  notes.push("run without --findings for the inventory, the client weight and the full disclosure");
  for (const note of notes) lines.push(`  ${paint(note, DIM, options.colour)}`);

  lines.push("");
  return lines.join("\n");
}

/**
 * The sentence for a run that stopped, one per reason.
 *
 * The workspace case names the apps it found rather than only saying it found some: a reader who
 * pointed the tool at a monorepo root wants the path to type next, and a list of three directories
 * is that answer. Written as a `switch` over the kind so a fourth reason fails to compile here
 * rather than falling through to a sentence about a different one.
 */
/**
 * The apps a stop offers the reader, and the words that introduce them.
 *
 * Two reasons name apps — a declared workspace and a root that declares nothing — and they differ
 * only in why the apps could be named. The list itself, and the instruction that points at it,
 * are the same answer either way.
 */
function offeredApps(apps: readonly { readonly directory: string; readonly declares?: string }[]): {
  readonly named: string;
  readonly count: string;
  readonly instruction: string;
} {
  const named = apps
    .map((app) =>
      app.declares === undefined ? app.directory : `${app.directory} (next ${app.declares})`,
    )
    .join("\n  ");
  // A workspace can hold exactly one app, and "analyse one of them" then points at a list of one.
  // The instruction is the part the reader acts on, so it names what it is pointing at.
  return {
    named,
    count: plural(apps.length, "Next.js app", "Next.js apps"),
    instruction: apps.length === 1 ? "analyse it" : "analyse one of them",
  };
}

export function renderStop(reason: StopReason, colour: boolean): string {
  const text = ((): string => {
    switch (reason.kind) {
      case "no-project":
        return `No Next.js project found at or above ${reason.from}.`;
      case "no-app-router":
        return reason.hasPagesRouter
          ? `${reason.root} uses the Pages Router. next-coverage only reads the App Router.`
          : `${reason.root} has no app directory.`;
      case "workspace-root": {
        const { named, count, instruction } = offeredApps(reason.apps);
        return `${reason.root} is a workspace root, not a project. It holds ${count}; ${instruction}:\n\n  ${named}`;
      }
      case "apps-below": {
        const { named, count, instruction } = offeredApps(reason.apps);
        const sit = reason.apps.length === 1 ? "sits" : "sit";
        // Not "a workspace root": nothing here declares a workspace, and the directory has done
        // nothing to earn the noun. What it is, is a directory with apps under it, which is all the
        // sentence claims.
        return `No Next.js project at ${reason.from}, and no workspace declares one. ${count} ${sit} below it; ${instruction}:\n\n  ${named}`;
      }
    }
  })();
  return `\n  ${paint(text, DIM, colour)}\n`;
}

/**
 * How the silent entries divide. A single reason is named without a breakdown, because repeating
 * the total beside itself tells a reader nothing; two or more are listed with their counts, which
 * sum to the figure they follow.
 */
/**
 * Packages the code imports and this `node_modules` does not hold. Not a limit on the scan: an
 * installed package would have been external, and the closure stops at external, so an absent one
 * changes nothing the walk can see.
 *
 * The sentence says "not installed" rather than "the project does not have", because on a monorepo
 * most of what it names are the project's own workspace packages — declared, present on disk, and
 * simply not linked here. Measured: cal.com reports 105 packages of which 69 are its own, and
 * installing ai-chatbot's dependencies takes its figure from 62 to none with no source changed.
 * The old wording sent a reader looking for a dependency nobody was missing.
 *
 * Undeclared is worth separating from declared. One is an installer nobody ran; the other, in one
 * project, is 118 AppSync resolvers whose runtime provides the package elsewhere.
 */
function missingPackagesNote(packages: readonly MissingPackage[]): string | undefined {
  if (packages.length === 0) return undefined;
  const references = packages.reduce((total, entry) => total + entry.references, 0);
  const undeclared = packages.filter((entry) => entry.declared === "no");
  const named = packages
    .map((entry) => entry.name)
    .slice(0, 3)
    .join(", ");
  const rest = packages.length > 3 ? ` and ${packages.length - 3} more` : "";
  const declaredPart =
    undeclared.length === 0
      ? "each declared in the manifest, so an install would resolve them"
      : `${undeclared.length} of them declared nowhere in the manifest`;
  return (
    `${plural(references, "import names", "imports name")} ` +
    `${plural(packages.length, "package that is", "packages that are")} ` +
    `not installed — ${named}${rest} — ${declaredPart}`
  );
}

function silenceBreakdown(result: CoverageResult): string {
  const parts = [
    { count: result.silence.abstained, label: "abstained" },
    { count: result.silence.unwritten, label: "not yet written" },
    { count: result.silence.delegated, label: "suggested on another entry" },
    { count: result.silence.evaluated, label: "evaluated and unmatched" },
  ].filter((part) => part.count > 0);

  if (parts.length === 0) return "";
  const only = parts[0];
  if (parts.length === 1 && only !== undefined) return `, ${only.label}`;
  return `: ${parts.map((part) => `${part.count} ${part.label}`).join(", ")}`;
}
