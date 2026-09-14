# workspace-app

The sixth vendored project, and the only one that is not a project: it is a **monorepo**, and the
thing under test is what the scan does when the app it analyses is a member of one.

## What it is pinned to

**A workspace declared two directories above the app.** `pnpm-workspace.yaml` at the root, and
`apps/panel` is what gets analysed. The walk that finds the declaration is the whole fix — a reader
starting at the app saw no workspace at all, so every linked package looked like a dependency it
could not open.

**A request API called from a linked package, and from nowhere else.**
`packages/datos/src/index.ts` calls `cookies()`; nothing under `apps/panel` does. Before this the
file was never opened and the entry read as unused, which is the defect
`Asymmetric-al/core`'s `apps/admin` reported. Moving the call into the app would make the case pass
against the reading it exists to rule out.

**A `node_modules` symlink into the linked package.** `apps/panel/node_modules/@vendored/datos`
points at `packages/datos`, the way a package manager writes it. Without it the resolver never meets
the shape that made every external test answer yes about this project's own code.

**A sibling app the analysed one does not depend on.** `apps/informes` declares `next` and calls
`headers()`. The old reading kept any member declaring `next`, so its files were attributed to
`panel`. Nothing of it may appear in `panel`'s report — and `headers` must not read as used there.

## What it shares with the other five

It is vendored, committed, and runs on a fresh clone. It is read and never built or run — the
symlink is committed, not installed. It is excluded from this repo's `tsconfig.json` and
`biome.json`. Every file names in a comment what it is there for.

Its members vendor no `next`, so no surface is derived for them and this fixture proves the scan
rather than the catalog: what it pins down is which files are read and how their imports resolve.
