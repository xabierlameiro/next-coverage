# The external corpus

135 public Next.js 16.3+ projects, and the harness that runs this tool over them.

**Nothing here runs in the test suite.** It needs the network, it clones 135 repositories, and no
test references it. `pnpm test` is unaffected by everything in this directory.

## What it answers, and what it does not

The vendored fixtures under `test-support/` and this corpus answer different questions, and the
difference is the whole reason both exist.

| | fixtures | this corpus |
| --- | --- | --- |
| Can the tool read this shape? | yes, completely | only where a project happens to write it |
| Does anybody actually write it? | **no** — they were written to make a condition fire | yes, and that is the only place to learn it |

`test-support/overconfigured-app` is the clearest case of the first column: it sets every otherwise
unconfigured option so a condition over them can be proven to fire. Its own README says it is *"a
source of readable values, not a statement of priority"*. Priority comes from here, where a set
option means somebody wanted it.

What this corpus found that no fixture could: three `next.config` shapes the reader was blind to, a
constraint that could not be exercised because no public repository installs TypeScript 7, and that
every pass had measured without `--strict` — which made 51 conditions look dead
when a flag was withholding them.

## Running it

```bash
pnpm build                                   # the harness runs dist/cli.js
./corpus/run.sh "$TMPDIR/corpus-pass"        # the whole manifest
./corpus/probe.sh "$TMPDIR/corpus-pass" jakejarvis/jarv.is   # one project
node corpus/summarise.mjs "$TMPDIR/corpus-pass"
```

The work directory holds clones, tarballs and output. Give it somewhere with room — a pass moves
several gigabytes through it — and never the repository itself. Clones are deleted after each
project is analysed, which is a requirement and not hygiene: a full pass does not fit otherwise. Set
`KEEP=1` to keep one for inspection.

### Installing and building

Five conditions read something a clone does not carry — three open with a guard on `context.build`,
two read an installed dependency. Two environment variables supply it, both opt-in:

```
INSTALL=1 ./corpus/probe.sh <work-dir> owner/repo   # install what the project declares
BUILD=1   ./corpus/probe.sh <work-dir> owner/repo   # implies INSTALL, then runs `next build`
```

`INSTALL_LIMIT` (default 600s) and `BUILD_LIMIT` (default 900s) bound each step; `INSTALL_SCRIPTS=0`
passes `--ignore-scripts`, which is safer and fails any project needing a postinstall step.

**Both run third-party code** — install lifecycle scripts, then somebody else's build. That is the
cost of measuring a condition that reads a build, and the reason neither is on by default.

**Run them over a subsample, not the manifest.** A project only exercises these conditions if its
`next.config` declares the option they read, so fetch the configs and grep them rather than
installing 135 projects:

```
curl -s https://raw.githubusercontent.com/<owner>/<repo>/HEAD/next.config.ts
```

`install=` and `build=` in the first line of the `.txt` report what happened. `install=partial`
means the manager exited non-zero and still populated the tree — a failed postinstall, an engine
warning, a peer conflict — and the build is attempted anyway, because a partial install usually
builds. The honest measure of what got installed is `missingPackages` in the JSON, not the exit code.

**What stops a build is rarely the harness.** Of 20 projects probed with `BUILD=1`, 13 installed and
2 produced a build the tool could read. The rest wanted a secret the clone does not carry, a file a
prior codegen step writes, or a package manager version that corepack cannot supply here.

## Reading the output

Per project, under `out/`: `<slug>.txt` (the report), `<slug>.json` (default preset) and
`<slug>.strict.json`. Both presets, every time — see the note in `probe.sh` for why.

**Two checks separate a harness fault from a tool fault.** Both have already caught one being read
as the other:

- **`nextpkg=` in the first line of the `.txt`.** `MISSING` means `npm pack` failed, and the tool
  correctly reports *version unresolved* with exit 4. It looks exactly like the tool failing to read
  the project. `npm pack` fails intermittently with *truncated gzip input*; retry the entry.
- **A non-empty `entries` array in the JSON.** Empty with a `projectRoot` present means the project
  was found and not analysed — Pages Router, no app directory, or a workspace root. Those messages
  are correct answers and four projects in the manifest exist to keep them correct.

A project reporting fewer than 13 constraints checked is the canary. Read `constraints.unread`
first: it names the reading that could not be made. An empty `unread` with a low count is the case
worth chasing.

## Why the harness installs packages the way it does

`npm install` fails on these projects for three unrelated reasons: `workspace:*`, which npm does not
support; `EBADDEVENGINES`; and a home cache the sandbox will not write. The tool only needs
`node_modules/next/dist/docs`, so the harness unpacks the tarball of the exact declared version
instead, and sets `NPM_CONFIG_CACHE` under the work directory.

It resolves `^`/`~` ranges, the npm alias form (`npm:@typescript/typescript6@6.0.2`) and pnpm
catalog references (`catalog:` and `catalog:<name>`, read from `pnpm-workspace.yaml` at the
repository root rather than at the app). Every one of those was learned from a project reporting one
constraint short where the harness was at fault.

It installs `typescript` as well as `next`. Without it a project reports 12 rather than 13, and the
missing one is not a tool failure.

## What this corpus cannot measure

**The harness installs `next` and `typescript` and nothing else**, so every project analysed has an
otherwise empty `node_modules` — 47 declared packages missing per project, measured across all 115
that produce a report. A condition that reads an installed dependency therefore answers `false`
everywhere, and its silence over the whole corpus means nothing at all.

Two conditions read one today, both through `src/collect/packages.ts`:

| condition | reads | via |
| --- | --- | --- |
| `config/next-config-js/optimizePackageImports` | whether an imported package's entry is only re-exports | `entryIsReexportOnly` |
| `config/next-config-js/serverExternalPackages` | whether a dependency declares a native addon | `declaresNativeAddon` |

Both ran on 88 and 82 projects respectively and argued on none, which reads exactly like a
miscalibrated condition and is not one.

**The harness also never builds.** It clones and reads; 111 of the reports say *no production build
found*. Three more conditions open with a guard on `context.build` and are silent for that reason
alone:

| condition | reads |
| --- | --- |
| `config/next-config-js/generateBuildId` | the build id the build wrote |
| `config/next-config-js/productionBrowserSourceMaps` | how many browser source maps the build emitted, and their size |
| `config/next-config-js/output` | whether every route the build produced was prerendered |

Twelve corpus projects set `productionBrowserSourceMaps`. Its condition would argue on any of them
the moment a build existed, so its zero is the clearest case of a measurement that never happened
being read as a shape nobody writes.

**Before treating a zero as a finding, check whether the condition resolves a dependency or reads a
build.** Five of them do. Measuring those needs a harness that installs and builds, which is a
different tool.

## The config bench

One question this corpus answers far too expensively: **how many shapes of `next.config` can the
reader resolve.** A pass here clones and unpacks every project to answer it, and the reader never
needed any of that — `readNextConfig` takes a directory path and never file content, so a directory
holding the one file is the whole input.

`config-bench.ts` exploits that. 856 configs in roughly 400ms, against hours and gigabytes for the
same figure:

```bash
./corpus/fetch-configs.sh "$TMPDIR/configs"
BENCH_DIR="$TMPDIR/configs" BENCH_REPORT="$TMPDIR/bench.tsv" \
  pnpm vitest run --config corpus/config-bench.config.ts
```

`config-projects.txt` holds the slugs, one `owner/repo` per line, kept separate from `projects.txt`
because it is a different cohort with a different purpose: it needs breadth of config shape and
nothing else, so it carries projects this corpus would reject — Pages Router, Next 9, unmaintained.
Only the configs are downloaded, never the projects.

**No third-party file is stored here, so the cohort is a list of names and the files move.** Storing
the configs would mean shipping 3.7 MB of other people's code under mixed licences from a public
repository, to save a fetch anyone runs in one command. The
second column of each line is the truncated sha256 of that project's config as the last measurement
read it, and `fetch-configs.sh` prints `drifted:` — how many now differ. That is what makes two
figures comparable: a bench number that moved while `drifted` is large says nothing about a change to
the reader, and re-measuring both sides of the change against one freshly fetched directory is the
only way to read it. A slug with no hash was added since the last measurement and is not drift.
Refresh the column when a pass is the new baseline:

```bash
while read -r slug _; do
  f=$(ls "$TMPDIR/configs/${slug//\//__}"/next.config.* 2>/dev/null | head -1)
  [ -n "$f" ] && printf '%s\t%s\n' "$slug" "$(shasum -a 256 "$f" | cut -c1-16)" \
    || printf '%s\n' "$slug"
done < corpus/config-projects.txt > "$TMPDIR/rehashed.txt"
```

The TSV is one row per project: verdict, slug, detail. `RESOLVED` carries the number of properties
read, `UNRESOLVED` the reason, `NO_SOURCE` means no config was found, and **`THREW` is the one
verdict that is always a defect** — the reader is handed a file it did not write and must answer,
never raise.

**Read it as a comparison, not as a level.** The number that means something is the difference
between two passes over the same directory, one per side of a change. On 2026-09-27 a change to
which argument of a plugin call carries the config moved it from 732 resolved to 801, with 69
projects changing verdict and none regressing; both bugs fixed that day were found here and only
then confirmed through the harness.

The absolute figure is not coverage of the ecosystem. 55 configs still resist, and most are shapes no
reader reaches without resolving modules. Of the ones that did resolve, a verdict says the reader
reached an object literal — not that it reached the right one, which is what the harness checks by
counting constraints.

## The manifest

`projects.txt`, one `owner/repo [subpath]` per line. Entries rot as projects are renamed, deleted or
downgraded; a clone failure costs one line of output rather than a run.

Entries that never produce a figure are kept on purpose. `mui/material-ui docs`, `blockscout/frontend`
and `suitenumerique/docs …` are Pages Router; `incubateur-ademe/territoires-en-transitions` has no
app directory; `Southclaws/storyden` has no root `package.json`. Their messages are the ones a user
sees when the tool cannot analyse their project, and removing them would hide a regression in the
only place those messages are exercised.

## macOS

`timeout` does not exist. `timeout 600 next build` fails with *command not found* and leaves a log
that looks like an empty build.
