import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SourceIndex } from "../src/collect/sources.js";
import { scanSources } from "../src/collect/sources.js";
import type { Analysis, Preset } from "../src/index.js";
import { analyse } from "../src/index.js";
import { FIXTURES, fixtureAvailable } from "./fixtures.js";

/** What running the binary produced, or why it could not be run. */
export type CliRun = {
  readonly output: string;
  readonly stderr: string;
  /** What the process returned. `next-coverage --help` lists what each value means. */
  readonly status: number;
};

/** Analyses of the real fixtures, keyed by preset and path. */
export type SharedAnalyses = Readonly<Record<string, Analysis>>;

/** Scans of the real fixtures, keyed by path. */
export type SharedSources = Readonly<Record<string, SourceIndex>>;

export function analysisKey(path: string, preset: Preset): string {
  return `${preset}:${path}`;
}

declare module "vitest" {
  export interface ProvidedContext {
    readonly cliOnProject: CliRun | undefined;
    readonly cliWithoutProject: CliRun;
    readonly fixtureAnalyses: SharedAnalyses;
    readonly fixtureSources: SharedSources;
  }
}

/** The one place a test process is spawned, so no worker races another over the CPU. */
const exec = promisify(execFile);

/**
 * The one place a test process is spawned, so no worker races another over the CPU.
 *
 * Started rather than awaited. A subprocess runs on its own core, so the analysing below overlaps
 * with it instead of queueing behind it — measured by alternating both shapes three times, since
 * load on the machine running it can vary enough that two runs minutes apart cannot be compared:
 * 16.5s against 12.0s, and 14.5s against 12.9s.
 */
function start(cli: string, target: string): Promise<CliRun> {
  // A non-zero status rejects, and it is not a failure of the run: the CLI returns 2 when there is
  // no project, which is an answer. The status is captured rather than the rejection.
  return exec("node", [cli, target], { encoding: "utf8" }).then(
    ({ stdout, stderr }) => ({ output: stdout, stderr, status: 0 }),
    (error: unknown) => {
      const failed = error as { stdout?: string; stderr?: string; code?: number };
      return {
        output: failed.stdout ?? "",
        stderr: failed.stderr ?? String(error),
        status: failed.code ?? 1,
      };
    },
  );
}

/**
 * Analysing every available fixture under both presets, once.
 *
 * The same argument as the build below it: five test files analyse the same projects, and the
 * primary one costs 7.7 seconds a time. `once()` cannot help there — vitest gives each file its
 * own process, so its cache never crosses one. Computing here and shipping the result does, and
 * the result is under a megabyte of plain data.
 *
 * A fixture that is absent is simply not analysed; its tests already skip.
 */
/**
 * The scan of every available fixture — the expensive thing under almost everything else.
 *
 * Measured on one fixture: scanning is 8.5 seconds, and building the graph from a scan
 * that already exists is 20 milliseconds. So the scan is what ships and the graph is derived
 * where it is wanted, rather than sending both.
 *
 * It is 10.8 MB of plain records for that fixture, 55 milliseconds to serialise and 101 to read
 * back. Against 8.5 seconds a file, in five files, that is the trade.
 */
function scanFixtures(): SharedSources {
  const scans: Record<string, SourceIndex> = {};
  for (const fixture of FIXTURES) {
    if (!fixtureAvailable(fixture)) continue;
    scans[fixture.path] = scanSources(fixture.path);
  }
  return scans;
}

/**
 * Both presets of every available fixture, over the scan already made for it. Without that, one
 * fixture was scanned three times here: once per preset inside `analyse`, and once more
 * for the scan itself.
 */
function analyseFixtures(scans: SharedSources): SharedAnalyses {
  const analyses: Record<string, Analysis> = {};
  for (const fixture of FIXTURES) {
    if (!fixtureAvailable(fixture)) continue;
    const sources = scans[fixture.path];
    for (const preset of ["default", "strict"] as const) {
      analyses[analysisKey(fixture.path, preset)] = analyse(fixture.path, {
        preset,
        ...(sources ? { sources } : {}),
      });
    }
  }
  return analyses;
}

/**
 * Builds the CLI and runs it, once, before any test worker starts.
 *
 * Two things are being kept out of the workers. The build, because inside one it competes with
 * every other file running in parallel and doubled the suite. And the subprocesses, because a
 * test that spawns a process is the shape a flaky test takes: its cost depends on what else the
 * machine is doing.
 *
 * The assertions still live in the tests. Only the spawning moved.
 */
export default async function setup(context: {
  provide: {
    (key: "cliOnProject" | "cliWithoutProject", value: CliRun | undefined): void;
    (key: "fixtureAnalyses", value: SharedAnalyses): void;
    (key: "fixtureSources", value: SharedSources): void;
  };
}): Promise<void> {
  const root = process.cwd();
  execFileSync(join(root, "node_modules", ".bin", "tsup"), [], { stdio: "ignore" });

  const cli = join(root, "dist", "cli.js");
  if (!existsSync(cli)) throw new Error(`the build left no cli at ${cli}`);

  // Any materialized project will do; with none, the test over it skips rather than fails.
  const project = FIXTURES.find(fixtureAvailable);
  const onProject = project ? start(cli, project.path) : undefined;
  const withoutProject = start(cli, "/");
  const scans = scanFixtures();
  context.provide("fixtureSources", scans);
  context.provide("fixtureAnalyses", analyseFixtures(scans));
  context.provide("cliOnProject", await onProject);
  context.provide("cliWithoutProject", await withoutProject);
}
