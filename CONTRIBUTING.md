# Contributing

Thanks for looking. The most valuable contribution is a **false positive**: a suggestion the tool
made that does not apply to your project. Open an issue with that template before anything else; it
is how the heuristics get better.

## Running it from source

```bash
pnpm install
pnpm build
node dist/cli.js path/to/a/next/app
```

Node.js 20.19 or later, and the pnpm version `packageManager` pins (Corepack picks it up).

## The test suite

```bash
pnpm test
pnpm typecheck
pnpm lint
```

A fresh clone runs green with nothing else installed. Two kinds of fixture back the suite:

- **Vendored projects** under `test-support/*-app/`. Each was written to make a condition fire, is
  never built or run, and is excluded from typechecking and linting because it carries on purpose
  the flaws the conditions exist to find.
- **Pinned real projects**, listed in `test-support/pinned-projects.json` as a GitHub repository and
  a commit. They are not in this repository. `pnpm fixtures` materializes each one into `.fixtures/`
  at its commit and installs its lockfile without running any install script. Until you run it,
  their tests are registered and skipped, so the count of what did not run stays visible.

```bash
pnpm fixtures          # materialize what is missing (network, a few GB)
pnpm fixtures --force  # materialize everything again
```

CI materializes them and fails if any of their tests is skipped.

## Changes

- Match the surrounding code: TypeScript strict, `type` over `interface`, no `any`.
- A new condition needs a case that fires it, against a vendored project built for it, and the
  evidence it cites asserted.
- A condition must not name the project it was proven on. The catalog refuses a reason written that
  way.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- Pull requests are squash-merged, so the title becomes the commit on `main`. It must be a
  Conventional Commit too: release-please reads it to decide the next version and write the
  changelog, and a check fails a title it cannot parse.
- `pnpm lint:fix` formats with Biome.

## Reporting a security issue

See [SECURITY.md](SECURITY.md).
