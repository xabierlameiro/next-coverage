#!/usr/bin/env node
import { EXIT, type ExitStatus, parseArgs, renderHelp, statusFor } from "./cli-args.js";
import { analyse } from "./index.js";
import { renderFindings, renderReport, renderStop } from "./report/render.js";
import { serialiseReport } from "./report/serialise.js";

/** Inlined at build time from the manifest. Falls back for a run straight from source. */
declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

/**
 * The report goes to stdout; anything explaining why there is no report goes to stderr. A script
 * capturing stdout gets the report or nothing, never an explanation of its absence mixed in.
 */
function run(args: readonly string[]): ExitStatus {
  const invocation = parseArgs(args, process.cwd());

  if (invocation.kind === "usage-error") {
    process.stderr.write(`next-coverage: ${invocation.message}\nTry --help.\n`);
    return EXIT.usage;
  }
  if (invocation.kind === "help") {
    process.stdout.write(renderHelp(VERSION));
    return EXIT.ok;
  }
  if (invocation.kind === "version") {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  // Colour is a courtesy for humans; piped output stays plain, and JSON never carries it.
  const colour = invocation.json ? false : process.stdout.isTTY === true;
  const analysis = analyse(
    invocation.target,
    invocation.preset === "strict" ? { preset: "strict" } : {},
  );

  if (analysis.kind === "stopped") {
    process.stderr.write(renderStop(analysis.reason, false));
    return EXIT.nothingToAnalyse;
  }

  const options = {
    colour,
    version: analysis.version,
    projectRoot: analysis.projectRoot,
    ...(analysis.surfaceUnavailable === undefined
      ? {}
      : { surfaceUnavailable: analysis.surfaceUnavailable }),
  };

  // What was found does not reach the status: a report listing findings is an answer, and a caller
  // reading it as a failure is reading a coverage report as a gate. Whether there was a surface to
  // find anything against is a different question, and the one this status answers — a run with no
  // installed release reports every total at zero, which reads like a project that adopted
  // everything. The rendering does not decide it: it is a fact about the run, not about the flag.
  const status = analysis.surfaceUnavailable === undefined ? EXIT.ok : EXIT.surfaceUnavailable;

  if (invocation.json) {
    process.stdout.write(`${JSON.stringify(serialiseReport(analysis.result, options), null, 2)}\n`);
    return status;
  }

  const render = invocation.findings ? renderFindings : renderReport;
  process.stdout.write(render(analysis.result, options));
  return status;
}

function main(): void {
  process.exitCode = statusFor(
    () => run(process.argv.slice(2)),
    (message) => process.stderr.write(message),
  );
}

main();
