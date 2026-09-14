#!/bin/bash
# probe.sh <work-dir> <owner/repo> [subpath]
#
# Clones one project, installs just enough of `next` and `typescript` for the tool to read it, and
# writes three files under <work-dir>/out: the text report, the default-preset JSON, and the strict
# JSON. Deletes the clone afterwards unless KEEP=1.
#
# INSTALL=1 installs every declared dependency with the project's own package manager instead of the
# two tarballs the reading path needs; BUILD=1 implies it and then runs `next build`. Three
# conditions open with a guard on `context.build` and two read an installed dependency, so without
# these their zeros describe this script rather than the catalog.
#
# Both are opt-in and both run third-party code — install lifecycle scripts, then the project's own
# build. That is the cost of measuring a condition that reads a build, and the reason neither is the
# default. INSTALL_SCRIPTS=0 passes --ignore-scripts, which is safer and fails any project whose
# build needs a postinstall step.
#
# Both JSON outputs are produced every time on purpose. Measuring only the default preset is the
# mistake this corpus already made: 51 conditions looked dead when they were withheld by a flag.
set -o pipefail

WORK="$1"
REPO="$2"
SUB="${3:-}"
[ -z "$WORK" ] || [ -z "$REPO" ] && { echo "usage: probe.sh <work-dir> <owner/repo> [subpath]" >&2; exit 64; }

# The repository this script lives in, so a fresh clone finds its own dist/ wherever it sits.
NC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$NC/dist/cli.js"
[ -f "$CLI" ] || { echo "no dist/cli.js — run pnpm build first" >&2; exit 69; }

# Under the work directory, never under ~/.npm: a sandboxed home cache fails with EPERM, and that
# failure reads as a network problem.
export NPM_CONFIG_CACHE="$WORK/npmcache"
# The same reasoning for every other manager `INSTALL=1` can reach. Left alone, pnpm's store, yarn's
# cache and bun's install cache grow in the real home directory — which a sandboxed run cannot write
# either, so the EPERM reads as a network failure exactly as it did for npm.
export npm_config_store_dir="$WORK/pnpmstore"
export PNPM_HOME="$WORK/pnpmhome"
export YARN_CACHE_FOLDER="$WORK/yarncache"
export BUN_INSTALL_CACHE_DIR="$WORK/buncache"
INSTALL_LIMIT="${INSTALL_LIMIT:-600}"
BUILD_LIMIT="${BUILD_LIMIT:-900}"
INSTALL_SCRIPTS="${INSTALL_SCRIPTS:-1}"
mkdir -p "$WORK/out" "$WORK/packs" "$WORK/clones" "$NPM_CONFIG_CACHE" \
  "$npm_config_store_dir" "$PNPM_HOME" "$YARN_CACHE_FOLDER" "$BUN_INSTALL_CACHE_DIR"

SLUG="$(echo "${REPO}${SUB:+__${SUB//\//_}}" | tr '/' '_')"
OUT="$WORK/out/$SLUG.txt"
JSON="$WORK/out/$SLUG.json"
STRICT="$WORK/out/$SLUG.strict.json"
DIR="$WORK/clones/$SLUG"

if [ ! -d "$DIR/.git" ]; then
  rm -rf "$DIR"
  # A clone failure costs one line and not the run: the manifest rots as projects are renamed,
  # deleted or downgraded, and a pass has to survive that.
  if ! git clone --depth 1 --single-branch -q "https://github.com/$REPO.git" "$DIR" 2>"$WORK/out/$SLUG.clone.err"; then
    { echo "STATUS=clone-failed"; cat "$WORK/out/$SLUG.clone.err"; } > "$OUT"
    exit 0
  fi
fi

APP="$DIR${SUB:+/$SUB}"
if [ ! -f "$APP/package.json" ]; then
  echo "STATUS=no-package-json at ${SUB:-<root>}" > "$OUT"
  [ -z "$KEEP" ] && rm -rf "$DIR"
  exit 0
fi

# The version a project declares, in every form these projects declare one: a plain range, an npm
# alias, or a pnpm catalog reference resolved from pnpm-workspace.yaml at the repository root
# rather than at the app. Each form was found by a project reporting one constraint short, where
# the fault was here and looked like the tool's.
declared() {
  NC="$NC" node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const YAML = require(process.env.NC + "/node_modules/yaml");
    const [app, root, name] = process.argv.slice(1);
    let declaration = "";
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
      const deps = { ...manifest.devDependencies, ...manifest.dependencies };
      declaration = String(deps[name] || "");
      if (declaration.startsWith("catalog:")) {
        const key = declaration.slice(8).trim();
        for (const dir of [app, root]) {
          const file = path.join(dir, "pnpm-workspace.yaml");
          if (!fs.existsSync(file)) continue;
          const workspace = YAML.parse(fs.readFileSync(file, "utf8")) || {};
          const catalog =
            key === "" || key === "default" ? workspace.catalog : (workspace.catalogs || {})[key];
          if (catalog && catalog[name]) { declaration = String(catalog[name]); break; }
        }
      }
    } catch {}
    process.stdout.write(declaration);
  ' "$APP" "$DIR" "$1"
}

# `npm install` fails on these projects for three unrelated reasons — `workspace:*`, which npm does
# not support; EBADDEVENGINES; and a home cache the sandbox will not write. The tool only needs
# `node_modules/next/dist/docs`, so the tarball of the exact declared version is enough.
install_package() {
  local name="$1" declaration="$2" spec tarball extract
  [ -z "$declaration" ] && return 1
  case "$declaration" in
    npm:*) spec="${declaration#npm:}" ;;
    workspace:*|catalog*|link:*|file:*|*"*"*) return 1 ;;
    *) spec="$name@${declaration#^}" ;;
  esac
  spec="${spec/@~/@}"
  tarball=$(cd "$WORK/packs" && npm pack "$spec" --silent 2>/dev/null | tail -1)
  [ -z "$tarball" ] && return 1
  # $$ in the directory name: two probes running in parallel otherwise overwrite each other's
  # extraction and one of them unpacks a half-written tree.
  extract="$WORK/packs/x.$$"
  rm -rf "$extract"; mkdir -p "$extract"
  tar -xzf "$WORK/packs/$tarball" -C "$extract" || { rm -rf "$extract"; return 1; }
  mkdir -p "$APP/node_modules"; rm -rf "$APP/node_modules/$name"
  cp -R "$extract/package" "$APP/node_modules/$name"; rm -rf "$extract"
  return 0
}

# No `timeout` on a stock macOS, so the limit is a watchdog: the job runs in the background and a
# second process kills it if it outlives the budget. Without one a single project that hangs on a
# prompt stalls a whole pass.
run_with_limit() {
  local limit="$1"; shift
  "$@" >>"${LOG_FILE:-$WORK/out/$SLUG.install.log}" 2>&1 &
  local job=$! status=0
  # `kill -0` first: the pid is only killed while it is still a live child of this shell, so a job
  # that finished on time is not shot at through a recycled pid.
  ( sleep "$limit"; kill -0 "$job" 2>/dev/null && kill -9 "$job" 2>/dev/null ) >/dev/null 2>&1 &
  local watchdog=$!
  wait "$job" 2>/dev/null || status=$?
  # Killing the watchdog leaves its `sleep` orphaned until the budget elapses. It is idle and it
  # exits on its own; without `timeout` on macOS there is no cheaper way to bound a command.
  kill -9 "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return "$status"
}

# The project's own package manager, because the lockfile is the only thing that resolves a
# `workspace:*` or a `catalog:` reference. Guessing npm for a pnpm workspace is what made the
# tarball path necessary in the first place.
#
# The declared `packageManager` field wins over the lockfile: a project pinning yarn@4 has a
# `yarn.lock` a yarn@1 on PATH will read and then fail on, which reports as the project's fault
# rather than this script's. Only the manager is chosen here, never its version.
package_manager() {
  local declared
  declared=$(node -e '
    const fs = require("node:fs");
    for (const dir of process.argv.slice(1)) {
      try {
        const m = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8"));
        if (m.packageManager) { process.stdout.write(String(m.packageManager)); break; }
      } catch {}
    }
  ' "$APP" "$DIR" 2>/dev/null)
  case "$declared" in
    pnpm@*) echo pnpm; return ;;
    yarn@*) echo yarn; return ;;
    bun@*)  echo bun; return ;;
    npm@*)  echo npm; return ;;
  esac
  if [ -f "$DIR/pnpm-lock.yaml" ] || [ -f "$APP/pnpm-lock.yaml" ]; then echo pnpm
  elif [ -f "$DIR/yarn.lock" ] || [ -f "$APP/yarn.lock" ]; then echo yarn
  elif [ -f "$DIR/bun.lockb" ] || [ -f "$APP/bun.lock" ]; then echo bun
  else echo npm
  fi
}

install_all() {
  local pm scripts=()
  pm=$(package_manager)
  # No `corepack enable` here: it rewrites symlinks in the Node installation's bin directory, which
  # a sandboxed run cannot do, and its EPERM buries the install's own error. The field below picks
  # the right manager; running the pinned *version* of it is out of this script's reach.
  command -v "$pm" >/dev/null 2>&1 || { echo "no $pm on PATH"; return 1; }
  [ "$INSTALL_SCRIPTS" = "0" ] && scripts=(--ignore-scripts)
  case "$pm" in
    pnpm) run_with_limit "$INSTALL_LIMIT" pnpm --dir "$DIR" install --no-frozen-lockfile "${scripts[@]}" ;;
    yarn) run_with_limit "$INSTALL_LIMIT" yarn --cwd "$DIR" install "${scripts[@]}" ;;
    bun)  run_with_limit "$INSTALL_LIMIT" bun install --cwd "$DIR" "${scripts[@]}" ;;
    *)    run_with_limit "$INSTALL_LIMIT" npm install --prefix "$DIR" --no-audit --no-fund "${scripts[@]}" ;;
  esac
}

# The local binary rather than the project's own `build` script: the script often wraps the build in
# steps that need a database or a secret, and what the three conditions read is the build directory.
build_project() {
  local next_bin="$APP/node_modules/.bin/next"
  [ -x "$next_bin" ] || next_bin="$DIR/node_modules/.bin/next"
  [ -x "$next_bin" ] || { echo "no next binary after install"; return 1; }
  ( cd "$APP" && LOG_FILE="$WORK/out/$SLUG.build.log" NEXT_TELEMETRY_DISABLED=1 CI=1 \
      run_with_limit "$BUILD_LIMIT" "$next_bin" build )
}

NEXT_DECLARED=$(declared next)
TS_DECLARED=$(declared typescript)
NEXT_STATUS=ok
TS_STATUS=ok
INSTALL_STATUS=skipped
BUILD_STATUS=skipped
if [ -n "$INSTALL" ] || [ -n "$BUILD" ]; then
  INSTALL_STATUS=ok
  # A manager exits non-zero for a failed postinstall, an engine warning or a peer conflict and
  # still leaves a usable tree behind. `partial` says so rather than discarding the run: what the
  # two dependency conditions read is on disk or it is not, and the report's own missingPackages
  # figure is the honest measure of that.
  #
  # The test is `next` itself, not the existence of `node_modules`: every manager creates that
  # directory before it does the work, so testing for it would call almost every real failure
  # `partial` and leave `FAILED` reachable only when the binary is missing from PATH.
  install_all || INSTALL_STATUS=FAILED
  if [ "$INSTALL_STATUS" = "FAILED" ] &&
     { [ -d "$APP/node_modules/next" ] || [ -d "$DIR/node_modules/next" ]; }; then
    INSTALL_STATUS=partial
  fi
fi
if [ -n "$BUILD" ]; then
  # Attempted whenever a next binary exists, because a partial install often builds fine and
  # refusing to try turns one bad exit code into a missing measurement.
  if [ "$INSTALL_STATUS" = "ok" ] || [ "$INSTALL_STATUS" = "partial" ]; then
    BUILD_STATUS=ok
    build_project || BUILD_STATUS=FAILED
  else
    BUILD_STATUS=skipped-no-install
  fi
fi
[ -d "$APP/node_modules/next/dist/docs" ] || install_package next "$NEXT_DECLARED" || NEXT_STATUS=MISSING
# Without typescript the project reports one constraint fewer, which reads as a tool fault.
[ -d "$APP/node_modules/typescript" ] || install_package typescript "$TS_DECLARED" || TS_STATUS=MISSING

{
  echo "=== $REPO ${SUB:+($SUB)} next=$NEXT_DECLARED ts=$TS_DECLARED nextpkg=$NEXT_STATUS tspkg=$TS_STATUS install=$INSTALL_STATUS build=$BUILD_STATUS ==="
  node "$CLI" "$APP" 2>&1
  echo "EXIT=$?"
} > "$OUT"

node "$CLI" "$APP" --json 2>/dev/null > "$JSON" || true
[ -s "$JSON" ] || echo '{}' > "$JSON"
node "$CLI" "$APP" --strict --json 2>/dev/null > "$STRICT" || true
[ -s "$STRICT" ] || echo '{}' > "$STRICT"

# Deleting is the default because a full pass does not fit on disk otherwise. A previous session's
# scratchpad had reached 16 GB with 6.9 GB free.
[ -z "$KEEP" ] && rm -rf "$DIR"
exit 0
