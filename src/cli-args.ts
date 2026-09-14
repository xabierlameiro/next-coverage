import type { Preset } from "./catalog/types.js";

/**
 * What the process returns, and what each value means to a caller reading nothing else.
 *
 * `nothingToAnalyse` and `internalError` are separate because the caller's response differs: one
 * says the path was wrong, the other says this tool is. Folding them together would make a bug
 * look like a misconfigured directory, which is how bugs go unreported.
 */
export const EXIT = {
  /** The project was analysed. What the report found does not change this: it is not a gate. */
  ok: 0,
  /** The invocation was wrong: an unrecognised flag, or more than one directory. */
  usage: 1,
  /** There was nothing to analyse: no Next.js project, or no App Router. */
  nothingToAnalyse: 2,
  /** The tool failed. */
  internalError: 3,
  /**
   * The analysis ran, and no installed Next.js release was there to derive a surface from. Separate
   * from `nothingToAnalyse` because a report is still written: every total sits at zero, which reads
   * exactly like a project that adopted everything unless the status says which one happened.
   */
  surfaceUnavailable: 4,
} as const;

export type ExitStatus = (typeof EXIT)[keyof typeof EXIT];

/** The statuses `--help` lists. Kept beside `EXIT` so the help cannot fall behind it. */
export const EXIT_DESCRIPTIONS: readonly { readonly status: ExitStatus; readonly why: string }[] = [
  { status: EXIT.ok, why: "the project was analysed" },
  { status: EXIT.usage, why: "the invocation was wrong" },
  { status: EXIT.nothingToAnalyse, why: "no Next.js project, or no App Router" },
  { status: EXIT.internalError, why: "an internal error" },
  { status: EXIT.surfaceUnavailable, why: "no installed Next.js to derive a surface from" },
];

const FLAGS: readonly { readonly flag: string; readonly what: string }[] = [
  { flag: "--strict", what: "include the heuristics the default preset holds back" },
  { flag: "--findings", what: "render only what the run found, not the inventory" },
  { flag: "--json", what: "write the result as JSON, and nothing else, to stdout" },
  { flag: "--help", what: "show this and exit" },
  { flag: "--version", what: "print the version of this tool and exit" },
];

export type Invocation =
  | {
      readonly kind: "analyse";
      readonly target: string;
      readonly preset: Preset;
      readonly json: true | false;
      /** Render only what the run found, leaving out the inventory it found it in. */
      readonly findings: true | false;
    }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "usage-error"; readonly message: string };

/**
 * One pass over the arguments: anything starting with `-` is a flag and must be one we know,
 * anything else is the directory and there may be at most one.
 *
 * Both halves of that rule fix a way the previous parser answered the wrong question. It tested
 * `startsWith("--")`, so `-h` was not a flag to it and became the directory — the tool then walked
 * up from a path named `-h` and reported no project found. And an unknown `--flag` was dropped
 * silently, so a misspelled `--json` returned a rendered report and a zero status.
 */
export function parseArgs(args: readonly string[], cwd: string): Invocation {
  let target: string | undefined;
  let strict = false;
  let json = false;
  let findings = false;
  let help = false;
  let version = false;

  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (arg === "--strict") strict = true;
      else if (arg === "--json") json = true;
      else if (arg === "--findings") findings = true;
      else if (arg === "--help") help = true;
      else if (arg === "--version") version = true;
      else return { kind: "usage-error", message: `unknown option ${arg}` };
      continue;
    }
    if (target !== undefined) {
      return {
        kind: "usage-error",
        message: `expected one directory, got ${target} and ${arg}`,
      };
    }
    target = arg;
  }

  // Asking what the tool is is not asking it to look at a project, so a directory alongside is
  // not analysed rather than being an error: the question was answered.
  if (help) return { kind: "help" };
  if (version) return { kind: "version" };

  // The only pair of flags that has to be settled rather than accumulated. The JSON already carries
  // every channel the findings view reads, so asking for both is asking for a machine-readable
  // report and a shortened human one at once — and honouring either one silently is the failure this
  // parser was rewritten to stop making: a wrong invocation that returns a confident result.
  if (findings && json) {
    return {
      kind: "usage-error",
      message: "--findings shortens a report for a person and --json writes one for a program",
    };
  }

  return {
    kind: "analyse",
    target: target ?? cwd,
    preset: strict ? "strict" : "default",
    json,
    findings,
  };
}

/** The usage text, listing every flag and every exit status this tool can return. */
export function renderHelp(version: string): string {
  const flags = FLAGS.map(({ flag, what }) => `  ${flag.padEnd(11)} ${what}`).join("\n");
  const statuses = EXIT_DESCRIPTIONS.map(
    ({ status, why }) => `  ${String(status).padEnd(11)} ${why}`,
  ).join("\n");
  return [
    `next-coverage ${version}`,
    "",
    "API surface coverage for a Next.js App Router project.",
    "",
    "Usage:",
    "  next-coverage [directory] [options]",
    "",
    "The directory defaults to the working directory.",
    "",
    "Options:",
    flags,
    "",
    "Exit status:",
    statuses,
    "",
  ].join("\n");
}

/**
 * Runs the CLI and converts a thrown error into a status.
 *
 * Separate from `main` so it can be tested against a real throw. No input reaches this path: a
 * broken `next.config.ts` and an unreadable app directory both analyse cleanly and exit zero, so
 * the only thing that lands here is a defect in this tool — which is exactly why it must not be
 * folded into `nothingToAnalyse`, where it would read as a misconfigured directory.
 */
export function statusFor(
  run: () => ExitStatus,
  writeError: (message: string) => void,
): ExitStatus {
  try {
    return run();
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeError(`next-coverage: internal error\n${detail}\n`);
    return EXIT.internalError;
  }
}
