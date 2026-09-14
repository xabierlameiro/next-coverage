import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inject, it } from "vitest";
import type { ModuleGraph } from "../src/collect/graph.js";
import { buildGraph } from "../src/collect/graph.js";
import type { SourceIndex } from "../src/collect/sources.js";
import { scanSources } from "../src/collect/sources.js";
import type { Analysis, Preset } from "../src/index.js";
import { analyse } from "../src/index.js";
import { analysisKey } from "./build-cli.js";

/**
 * Real Next.js projects used as fixtures, each pinned to a commit.
 *
 * They are not vendored: each one is a full application with its own dependencies, and its value is
 * that its authors wrote it for their own reasons. They are not read at whatever state their
 * repository is in either, because an assertion that moves with the project fails for the
 * project's changes rather than for this tool's. `pnpm fixtures` materializes each one into
 * `.fixtures/` at its pinned commit, with its lockfile installed and no install script run.
 *
 * A project that is not materialized skips its tests rather than failing, so a fresh clone runs
 * green, and the skip is registered so the count of what did not run stays visible.
 */
export type Fixture = {
  readonly name: string;
  /** Where the tests read it: the materialized copy, never the source repository. */
  readonly path: string;
  readonly commit: string;
  /** The Next.js release its lockfile resolves. */
  readonly next: string;
  readonly role: string;
};

type PinnedProject = {
  readonly name: string;
  /** A GitHub `owner/repo`, or a path to a local repository. */
  readonly source: string;
  readonly commit: string;
  readonly next: string;
  readonly role: string;
  /** The analysed application, relative to the repository root, when it is not the root. */
  readonly app?: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".fixtures");

function registry(file: string): readonly PinnedProject[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PinnedProject[]) : [];
}

/**
 * Every pinned project this checkout knows. The public registry ships with the repository; an
 * optional second one lets a maintainer pin projects that cannot be published, and its absence is
 * the ordinary case.
 */
const PUBLIC_PINNED = registry(join(ROOT, "test-support", "pinned-projects.json"));
const PINNED: readonly PinnedProject[] = [
  ...PUBLIC_PINNED,
  ...registry(join(ROOT, "private", "pinned-projects.json")),
];

/** Mirrors `cacheName` in `materialize.mjs`, which is plain JavaScript so it runs without a build. */
function cacheName(project: Pick<Fixture, "name" | "commit">): string {
  return `${project.name}@${project.commit.slice(0, 12)}`;
}

/** The fixture for a pinned project, by name. Fails loudly for a name no registry pins. */
export function pinnedFixture(name: string): Fixture {
  const project = PINNED.find((candidate) => candidate.name === name);
  if (project === undefined) throw new Error(`no registry pins a project named ${name}`);
  return {
    name: project.name,
    path: join(CACHE, cacheName(project), project.app ?? ""),
    commit: project.commit,
    next: project.next,
    role: project.role,
  };
}

/**
 * Every project this checkout pins. A test iterating it asserts what holds of any real project, so
 * it runs over the public ones on a public clone and over the private ones too where they exist. A
 * test about one project names that project's fixture instead.
 */
export const FIXTURES: readonly Fixture[] = PINNED.map((project) => pinnedFixture(project.name));

/** The pinned projects the public registry ships, which are the ones a public snapshot exists for. */
export const PUBLIC_FIXTURES: readonly Fixture[] = PUBLIC_PINNED.map((project) =>
  pinnedFixture(project.name),
);

/**
 * Whether a pinned project is materialized. Where `NEXT_COVERAGE_REQUIRE_FIXTURES` is set, as CI
 * sets it after materializing, an absent one fails instead of skipping, because a skip there means a
 * test stopped running and would otherwise read exactly like one that passed.
 */
export function fixtureAvailable(fixture: Pick<Fixture, "name" | "commit">): boolean {
  const available = existsSync(join(CACHE, `${cacheName(fixture)}.json`));
  if (!available && process.env.NEXT_COVERAGE_REQUIRE_FIXTURES === "1") {
    throw new Error(`${fixture.name} is not materialized; run \`pnpm fixtures\` first`);
  }
  return available;
}

/**
 * One test per candidate fixture, with the ones that are not materialized skipped rather than left
 * out.
 *
 * Written by hand, this reads `it.each` over a list filtered by availability, and that shape has a
 * failure mode nobody sees while the fixtures are present: filtering to nothing leaves `it.each`
 * with an empty list, which registers no tests, and a `describe` holding none is an error rather
 * than a skip. So the block passes where the fixtures exist and fails on a clean clone.
 *
 * Registering every candidate and skipping the absent ones has no such edge: the count of skips
 * stays honest, the suite never has an empty suite to complain about, and `$fixture.name` in the
 * title still names the project the way `it.each` would have.
 */
export function eachFixture(
  candidates: readonly Fixture[] = FIXTURES,
): (name: string, body: (row: { readonly fixture: Fixture }) => void | Promise<void>) => void {
  return (name, body) => {
    for (const fixture of candidates) {
      it.skipIf(!fixtureAvailable(fixture))(name.replaceAll("$fixture.name", fixture.name), () =>
        body({ fixture }),
      );
    }
  };
}

/**
 * Analysing a real project takes seconds. Tests share one result per fixture: the
 * pipeline is deterministic, so re-running it per assertion buys nothing.
 */
const cache = new Map<string, unknown>();

export function once<T>(key: string, compute: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const value = compute();
  cache.set(key, value);
  return value;
}

/**
 * The scan of a fixture, done once for the whole run. It is the expensive step under almost every
 * other one: seconds on a large project, against milliseconds to build a graph from it.
 *
 * `once()` cannot share it across files, because vitest gives each file its own process. The
 * global setup scans every materialized fixture and ships the result. This falls back to scanning
 * here when the setup provided nothing, so a file run without global setup is slow, not broken.
 */
export function sharedSources(fixture: Fixture): SourceIndex {
  const provided = inject("fixtureSources")?.[fixture.path];
  return provided ?? once(`scan:${fixture.path}`, () => scanSources(fixture.path));
}

/** The graph of a fixture, derived from the shared scan rather than shipped beside it. */
export function sharedGraph(fixture: Fixture): ModuleGraph {
  return once(`graph:${fixture.path}`, () => buildGraph(sharedSources(fixture)));
}

export function okAnalysis(
  fixture: Fixture,
  preset: Preset = "default",
): Extract<Analysis, { kind: "ok" }> {
  const analysis = sharedAnalysis(fixture, preset);
  if (analysis.kind !== "ok") throw new Error(`expected ${fixture.name} to analyse`);
  return analysis;
}

/** The analysis of a fixture, computed once for the whole run by the global setup. */
export function sharedAnalysis(fixture: Fixture, preset: Preset = "default"): Analysis {
  const provided = inject("fixtureAnalyses")?.[analysisKey(fixture.path, preset)];
  return (
    provided ?? once(`analysis:${preset}:${fixture.path}`, () => analyse(fixture.path, { preset }))
  );
}

/**
 * Which conditions report on code somebody runs, and where, across the given projects. Evaluated
 * under the strict preset so that a condition held back by the default one is not mistaken for a
 * silent one — the question here is whether the condition has anything to say, not whether the
 * report shows it.
 *
 * A condition counts as firing when it puts an entry in the would-apply bucket or reports partial
 * adoption. Both are the condition holding; only the placement differs, and an entry whose API is
 * already used elsewhere would otherwise read as silent.
 *
 * Vendored fixtures are deliberately excluded. They were written to make conditions fire, so they
 * answer whether a condition *can* fire — the question `UNCOVERED` in `src/catalog/corpus.test.ts`
 * already answers — rather than whether it fires where a reader would see it.
 */
export function firingOnRealCode(
  projects: readonly Fixture[] = FIXTURES,
): ReadonlyMap<string, readonly string[]> {
  return once(`firing-on-real-code:${projects.map((project) => project.name).join(",")}`, () => {
    const firing = new Map<string, string[]>();
    for (const fixture of projects) {
      if (!fixtureAvailable(fixture)) continue;
      const analysis = sharedAnalysis(fixture, "strict");
      if (analysis.kind !== "ok") continue;
      for (const entry of analysis.result.entries) {
        if (entry.bucket !== "would-apply" && entry.alsoWouldApply === undefined) continue;
        const seen = firing.get(entry.id);
        if (seen === undefined) firing.set(entry.id, [fixture.name]);
        else seen.push(fixture.name);
      }
    }
    return firing;
  });
}

/** Whether the measurement above can be made at all: with no fixture present, nothing fires. */
export function realCodeAvailable(projects: readonly Fixture[] = FIXTURES): boolean {
  return projects.some((fixture) => fixtureAvailable(fixture));
}
