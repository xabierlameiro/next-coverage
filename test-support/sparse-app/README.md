# sparse-app

The second vendored project. Where `incomplete-app` is wrong on purpose, this one **lacks on
purpose** — and it lacks precisely what `incomplete-app` adopts.

`incomplete-app` carries one case per condition, each isolated in its own route segment so the cases
cannot silence each other. That works for every condition that reads a segment. It does not work for
a condition that reads the whole project, because a project cannot at once use a convention and
argue for it. Three conditions need shapes `incomplete-app` cannot have while keeping the cases it
already carries, so they live here.

## What it is pinned to

**No parallel slot anywhere.** `incomplete-app` uses one at `app/panel/@lateral` for the `default`
case, which puts `parallel-routes` in the *used* bucket there — and a would-apply condition cannot
argue for an entry the project already adopts. Here `app/panel/layout.tsx` composes two
independently loading boundaries with no slot, which is the shape the convention's documentation
gives as the reason to reach for one.

**No template file, in any casing.** `file-conventions/template` already ships a proven condition:
`casingNearMiss`, which fires on `incomplete-app`'s deliberately miscased `app/Template.tsx`.
Evaluation returns the first proven condition that matches, so a second condition on that entry is
unreachable in any project where the casing one holds. Here nothing named `template` exists in any
spelling, so the second condition is the one that runs.

**A sitemap, and no robots file.** `robots` fires when a sitemap exists and nothing announces it;
`sitemap` fires when none exists. `incomplete-app` is pinned to the second and says so in its own
README, leaving `robots` "to a case elsewhere". This is that case.

**A metadata object carrying a viewport field, and one carrying none.** `app/ajustes/page.tsx`
exports `themeColor` inside its metadata object, which the framework documents as moved out into
the viewport export; `app/informe/page.tsx` exports a metadata object without any of the three, so
the condition has a negative in the same project. Neither is a whole-project property: they are
here because this project's pages had no metadata at all and could take them without silencing
anything.

**A client nav a layout renders, and an identical one a page renders.**
`app/panel/Navegacion.tsx` compares `usePathname` against paths written down in it and is rendered
by `app/panel/layout.tsx`, which is the shape the segment hooks return without the strings.
`app/panel/Filtros.tsx` does the same read and is rendered by `app/panel/page.tsx` — a page has no
active child to find, so it is the negative. `app/ajustes/layout.tsx` is a third case by accident
and a useful one: it calls the hook and compares nothing, so it stays out.

**A client file showing a documented reason for its directive, and one showing none.**
`app/informe/Aviso.tsx` declares `'use client'` and calls no hook, passes no handler, names no
browser global, imports no `client-only`, extends no component class and makes no context, so the
strict condition on the client directive entry reports it; the helper it imports is reached from
there and nowhere else, which is the count reported beside it. `app/panel/Navegacion.tsx` and
`app/panel/Filtros.tsx` are the negatives, both calling `usePathname`.

**A social image shipped from `public/`, and a segment where the convention answers instead.**
`app/prensa/page.tsx` names `/social.png` in its metadata and its segment holds no image
convention, which is the convention's two halves — the image and the tag pointing at it — kept
apart by hand. `app/difusion/page.tsx` names the same image and sits beside
`app/difusion/opengraph-image.tsx`, so the convention wins there and it is the negative. This is
why the project has a `public/` directory at all.

**A proxy under an extension that is not `.ts` or `.js`.** `proxy.tsx` at the root. The reading
that locates a proxy was written from four literal names, so every reader that asks where a proxy
sits was blind to any other documented page extension. Pinned to `.tsx` specifically: renaming it
would make the case pass against the reading it exists to rule out.

These four are asserted directly in `corpus.test.ts`, not merely written here. A later case that
took one away would otherwise silence a condition without failing a test.

## What it shares with `incomplete-app`

It is vendored, committed, and runs on a fresh clone. It is read and never built or run. It is
excluded from this repo's `tsconfig.json` and `biome.json`, because linting a project written to
carry flaws would report the flaws. Every file names in a comment the condition it exists for.

Its `next.config.ts` is empty. `incomplete-app` turns flags on to reach flag-gated entries; nothing
here is flag-gated, and a flag would only add a way for the two projects to differ.
