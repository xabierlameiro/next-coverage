#!/usr/bin/env node
/**
 * Materializes every pinned project into `.fixtures/`, where the tests read it.
 *
 *   pnpm fixtures          materialize what is missing
 *   pnpm fixtures --force  materialize everything again
 *
 * A pinned project is `{ name, source, commit, app?, build? }`. Its sources are exported at the
 * commit with `git archive` — no checkout, no worktree, nothing written to the source repository —
 * and its dependencies are installed from the lockfile at that commit with no install script run.
 * A project locked by npm or yarn is converted with `pnpm import`, which keeps every resolved
 * version and changes only the layout.
 *
 * `source` is a GitHub `owner/repo`, fetched once into `.fixtures/.repos/`, or a path to a local
 * repository (`~` expands). `build: "copy"` copies a local project's `.next`, without its cache, as
 * it stands when this runs; it is meant for projects whose build cannot be produced here.
 *
 * A project is written to a `.partial` directory and renamed when complete, so an interrupted run
 * never leaves one that looks materialized.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".fixtures");
const REGISTRIES = [
  join(ROOT, "test-support", "pinned-projects.json"),
  join(ROOT, "private", "pinned-projects.json"),
];
const GITHUB = /^[\w.-]+\/[\w.-]+$/;

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      // A project's own `packageManager` field must not make pnpm fetch another pnpm.
      npm_config_manage_package_manager_versions: "false",
      COREPACK_ENABLE_STRICT: "0",
      COREPACK_ENABLE_PROJECT_SPEC: "0",
    },
  });
}

function pinned() {
  return REGISTRIES.filter((file) => existsSync(file)).flatMap((file) =>
    JSON.parse(readFileSync(file, "utf8")),
  );
}

export function cacheName(project) {
  return `${project.name}@${project.commit.slice(0, 12)}`;
}

function repository(project) {
  if (!GITHUB.test(project.source)) return project.source.replace(/^~(?=\/|$)/, homedir());
  const bare = join(CACHE, ".repos", `${project.source.replace("/", "__")}.git`);
  if (!existsSync(bare)) {
    mkdirSync(dirname(bare), { recursive: true });
    run("git", [
      "clone",
      "--bare",
      "--filter=blob:none",
      `https://github.com/${project.source}.git`,
      bare,
    ]);
  }
  try {
    run("git", ["--git-dir", bare, "cat-file", "-e", `${project.commit}^{commit}`]);
  } catch {
    run("git", ["--git-dir", bare, "fetch", "origin", project.commit]);
  }
  return bare;
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

/**
 * Installs from the lockfile nearest the app: the app's own when it carries one, as an app kept in a
 * repository that is not a workspace does, and the repository root's otherwise.
 */
function install(root, app) {
  const locked = (directory) => LOCKFILES.some((file) => existsSync(join(directory, file)));
  const directory = app !== undefined && locked(join(root, app)) ? join(root, app) : root;
  if (!locked(directory)) {
    throw new Error(`${directory} carries no lockfile, so its dependencies cannot be pinned`);
  }
  if (!existsSync(join(directory, "pnpm-lock.yaml"))) run("pnpm", ["import"], directory);
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], directory);
}

function materialize(project, force) {
  const name = cacheName(project);
  const target = join(CACHE, name);
  const marker = `${target}.json`;
  if (existsSync(marker) && !force) return "present";

  const partial = `${target}.partial`;
  const archive = `${target}.tar`;
  rmSync(partial, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
  rmSync(marker, { force: true });
  mkdirSync(partial, { recursive: true });

  try {
    const git = repository(project);
    const gitArguments = GITHUB.test(project.source) ? ["--git-dir", git] : ["-C", git];
    run("git", [...gitArguments, "archive", "--format=tar", "-o", archive, project.commit]);
    run("tar", ["-xf", archive, "-C", partial]);

    install(partial, project.app);

    if (project.build === "copy") {
      const built = join(git, project.app ?? "", ".next");
      if (!existsSync(built)) throw new Error(`${project.name} has no build at ${built} to copy`);
      cpSync(built, join(partial, project.app ?? "", ".next"), {
        recursive: true,
        preserveTimestamps: true,
        filter: (path) => !path.startsWith(join(built, "cache")),
      });
    }
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(archive, { force: true });
  }

  renameSync(partial, target);
  writeFileSync(
    marker,
    `${JSON.stringify({ ...project, materializedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return "materialized";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes("--force");
  let failed = 0;
  for (const project of pinned()) {
    try {
      console.log(`${cacheName(project)}: ${materialize(project, force)}`);
    } catch (error) {
      failed += 1;
      console.error(
        `${cacheName(project)}: failed — ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  process.exitCode = failed === 0 ? 0 : 1;
}
