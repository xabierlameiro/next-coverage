# next-coverage

[![npm](https://img.shields.io/npm/v/next-coverage)](https://www.npmjs.com/package/next-coverage)
[![CI](https://github.com/xabierlameiro/next-coverage/actions/workflows/ci.yml/badge.svg)](https://github.com/xabierlameiro/next-coverage/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/next-coverage)](package.json)
[![license](https://img.shields.io/npm/l/next-coverage)](LICENSE)

**API surface coverage for Next.js App Router projects.** It does not score your code or hunt for
bugs. It answers one question: *which parts of the framework are you leaving on the table?*

```bash
npx next-coverage            # in the directory of a Next.js app
npx next-coverage path/to/app
```

Every Next.js API lands in one of three buckets:

| Bucket | Meaning |
| --- | --- |
| **Used** | It appears in your project. Reported with where and how many times. |
| **Would apply** | It does not appear, but a detectable condition in your code makes it relevant. Reported with what was seen, what adopting it buys, and the page that documents it. |
| **Not applicable** | Ruled out by an explicit signal. Silenced, but still visible. |

The value lives in the second bucket. Because the tool never claims something is *wrong*, a bad
guess costs you a dismissed suggestion, not a false positive.

## Requirements

- Node.js 20.19 or later.
- An App Router project on **Next.js 16.2 or later**, with its dependencies installed. The tool
  reads the documentation the installed `next` package ships, so an older release reports that the
  surface cannot be derived instead of falling back to a stale list.

Nothing is built, run or sent anywhere. The tool reads files.

## What it reports

Beside the buckets, and not a fourth one, sit channels that hang off an entry without moving it.

**Documented constraints your code contradicts.** An API can be used and still have one of its
documented rules broken. The finding reports what the framework does as a result, never that the
code is wrong, and the report states how many constraints it checked even when none is contradicted.
**Thirteen are checked today.** A check counts only where the thing it compares against could be
read, so a lower figure comes with what could not be read and why.

The thirteen fall into nine kinds of finding. **Four read what the installed Next.js applies to
every project whether or not the configuration says so**: the packages it already optimizes imports
for, the ones it already treats as server-external, the ones it already transpiles, and the value it
gives an option you did not set. They report where your configuration says the same thing again.
That is not advice to delete the line: a project may pin a value against a release that changes it.

**Seven read your configuration against the rest of your project**: a path `redirects` or
`rewrites` routes away from while a file still answers there (one check each), a module the
configuration names and the project does not provide, an option whose scope is a bundler your
scripts do not run, an option whose documented prerequisite is absent, an image source written
without the `basePath` the documentation asks you to prefix by hand, and a route segment still
exporting a config that `cacheComponents` removed.

The last two need the versions in play. **One is about rendering**: slots of one segment share a
mode, so a static slot beside a dynamic one is not prerendered. **One is about a combination the
documentation calls out**: an option whose value fails the build against the installed TypeScript
major.

**Pair rules across files.** A cache tag nothing invalidates, an invalidation of a tag nothing
produces, a `revalidatePath` no route serves.

**The client boundary.** The module graph gives the client closure: every file declaring
`'use client'` plus everything it reaches. A module importing `server-only` that the client side
reaches is reported with the import chain that causes it. The graph joins files, not symbols, so a
barrel can over-reach; the chain is printed in full so you can judge it.

**What your build did with the claims the tool derived.** If the project holds a production build,
the tool reads the manifests it left behind and says what the framework actually produced for a
route it made a claim about. A build that is absent, unreadable or older than the source draws
nothing and says why.

**Its own coverage gap.** An API your Next.js documents and this tool cannot detect is reported as
the tool's gap, not silently omitted. An entry that holds no verdict says why.

## The catalog is not hand-written

Next.js has bundled its own documentation inside the package since 16.2. `next-coverage` reads
`node_modules/next/dist/docs/` and derives the API surface from the version *you actually have
installed*, then joins it with hand-authored detection heuristics.

This matters because the surface moves between releases: `io`, `next-root-params`, `use-offline`
and `partialPrefetching` appear in 16.3, `viewTransition` disappears. A hand-maintained list would
suggest APIs your project does not have, or miss the ones it does.

## Presets

The default preset only runs heuristics whose condition is provable. Ones that report what was
observed rather than what was proven are opt-in:

```bash
npx next-coverage            # provable conditions only
npx next-coverage --strict   # also the observed ones
```

The report always states how many suggestions the active preset withheld, so a silent cap cannot
read as an absence of findings.

## Only what it found

The full report leads with the inventory: every API in use, and where. To see only what you could
act on:

```bash
npx next-coverage --findings            # the findings, without the inventory
npx next-coverage --strict --findings
```

It keeps the *would-apply* bucket whole and every finding hanging off a used entry, drops the
inventory, and says how many entries it did not print. The wording of a finding is identical in
both renderings.

## Using it from a script

```bash
npx next-coverage --json           # the result as JSON, and nothing else, on stdout
npx next-coverage --help           # every flag and every exit status
npx next-coverage --version        # the version of this tool, not of Next.js
```

The report goes to stdout. Anything explaining why there is no report goes to stderr, so a script
capturing stdout gets the report or nothing. When the directory holds no project but Next.js apps
sit inside it, the message names them and the version each declares.

| exit | meaning |
| --- | --- |
| `0` | the project was analysed, whatever the report found |
| `1` | the invocation was wrong: an unrecognised flag, or more than one directory |
| `2` | there was nothing to analyse: no Next.js project, or no App Router |
| `3` | an internal error |
| `4` | no installed Next.js to derive a surface from |

`4` still writes a report, with every total at zero, so the status says why.

**Findings never change the exit status.** A coverage report is not a gate. To fail a build on what
the report found, read the JSON and decide: on a bucket, a contradicted constraint, a claim the
build disagreed with, or any count the summary states.

### The JSON contract

```json
{
  "schemaVersion": 1,
  "nextVersion": "16.3.0",
  "preset": "default",
  "projectRoot": "/path/to/project",
  "totals": { "used": 83, "evaluated": 85, "notApplicable": 4, "notEvaluated": 65 },
  "constraints": { "checked": 13, "contradicted": 3, "withoutEntry": 73 },
  "entries": [
    {
      "id": "components/image",
      "domain": "components",
      "bucket": "would-apply",
      "evidence": ["app/gallery/page.tsx"],
      "note": "these render a raw img element, so nothing resizes or lazy-loads it",
      "gain": "Image serves each one resized to the viewport in a modern format, lazy-loads it below the fold and reserves its box so the layout does not shift",
      "docs": {
        "path": "02-components/image.md",
        "url": "https://nextjs.org/docs/app/api-reference/components/image"
      }
    }
  ]
}
```

Abbreviated: `totals` carries every count the summary prints, `build` and `weights` carry the build
contrast and the client code per route, and `entries` holds every API of the derived surface.

`bucket` is one of `used`, `would-apply`, `not-applicable` or `not-evaluated`. `gain` is present on
a suggestion and nothing else. `reasons` appears when two or more conditions composed one
suggestion, each with its own `note`, `gain` and `evidence`. `docs` is on every entry: the page it
was derived from, as the path the installed package ships and as the public URL. The channels that
hang off an entry are fields of it, each absent when empty: `silence`, `skippedForFlag`,
`needsBuild`, `alsoWouldApply`, `unmatched`, `leaks` and `constraints`.

**Every channel the terminal report prints has a field here**, and the other way round.
`constraints.checked` matters most when `contradicted` is zero: it separates a project found clean
from one nobody looked at.

**Adding a field does not raise `schemaVersion`; removing one or changing what it means does.**

## Limitations

- **App Router only.** A Pages Router project, or a directory with no `app/`, is reported as such.
- **One app per run.** At a workspace root the tool names the apps inside it; run it on each.
- **Files, not symbols.** The module graph follows imports between files. Symbol-level reach needs
  the type checker, which this tool does not run, and findings that rest on the graph are held
  behind `--strict`.
- **A build is read, never produced.** Without a `.next/` directory the build contrast is empty and
  says so. Its manifest formats are undocumented and drift between minors; an unknown version is
  refused rather than guessed.
- **Precision is measured, not guaranteed.** Each condition is proven against a project built to
  trigger it and checked on real projects, but a real codebase can still hold a shape nobody
  anticipated. That is what the false-positive report below is for.

## Status

**Beta.** The report is deterministic and every finding cites its evidence. Under `0.x` a minor
release may change the CLI or the JSON contract; `schemaVersion` moves whenever the JSON shape
does, and the [changelog](CHANGELOG.md) says so.

## Roadmap

Shipped: the inventory, pair rules across files, the module graph and the client boundary, the
documented constraints, and the rendering-mode half of the build contrast.

Next:

- **Conditions that fire on real code.** Widen what the *would apply* bucket can argue on projects
  people actually run, measured against public projects rather than fixtures built to trigger them.
- **Suppressing a finding** you have looked at and dismissed, per file or per entry.
- **Output for CI**: SARIF and GitHub annotations beside the JSON.
- **Whole workspaces** in one run.
- **The rest of the build contrast**, where a build records enough to compare against.

## Why not a linter

Linters answer "is this line wrong?". That question is already served by
`@next/eslint-plugin-next`, Biome and oxlint, and it is answered file by file. Two of the things
that matter most in the App Router are not file-scoped:

- **The client boundary is transitive.** `'use client'` is viral downward, so judging it one file
  at a time produces noise.
- **Caching is a graph effect.** A missing `cacheTag` is not "less optimal": it means that data can
  no longer be invalidated at all.

## Reporting a false positive

A suggestion that does not apply to your project is the most useful thing you can report. Open an
issue with the **false positive** template: it asks for the entry id, the evidence the report cited,
your Next.js version and the preset. See [CONTRIBUTING.md](CONTRIBUTING.md) to run the tool from
source.

## License

MIT

---

Not affiliated with or endorsed by Vercel. Next.js is a trademark of Vercel, Inc.
