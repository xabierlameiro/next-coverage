# Changelog

All notable changes to this project are recorded here. From 0.1.1 on, release-please writes each
entry from the Conventional Commits merged to `main`. The project follows
[Semantic Versioning](https://semver.org/) with the `0.x` rule: a minor release may change the CLI or
the JSON contract. `schemaVersion` in the JSON output moves whenever its shape does, and the entry
says so.

## 0.1.0 (2026-09-14)

First public release.

### Features

- The API surface derived from the documentation the installed Next.js ships (16.2 or later), and
  every API classified as used, would apply, not applicable or not evaluated.
- Documented constraints the project's code or configuration contradicts, with the count checked.
- Pair rules across files: cache tags and invalidations that do not meet, `revalidatePath` calls no
  route serves.
- The module graph: the client closure, `server-only` reached from the client with its import chain,
  and client code attributed per route.
- The build contrast: rendering-mode claims checked against the manifests of an existing production
  build.
- `--strict` for heuristics that report what was observed rather than proven, `--findings` for the
  findings without the inventory, and `--json` with `schemaVersion: 1`.
