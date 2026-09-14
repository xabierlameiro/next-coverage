# incomplete-app

A Next.js project that is **wrong on purpose**. Nothing here is an oversight.

The three fixtures in `fixtures.ts` are real applications, thoroughly configured, and between them
they produce one, two and four would-apply suggestions. A condition that is silent because nothing
matches it is indistinguishable from one that is silent because it is broken — so most of what the
catalog can argue had never been seen to fire.

This project carries one case per condition, each in its own route segment so the cases cannot
silence each other: a `loading` file added for one condition would cover every async page beneath
it. Each file's comment in the generator names the condition it exists for.

It is vendored rather than referenced, which is the opposite of the other three and for the
opposite reason: they must drift with their real dependencies, and this one must not move at all.
It is committed, so it runs on a fresh clone where the others are skipped for absence.

It is excluded from `tsconfig.json` and `biome.json`. It imports `next/link` and `next/image`,
which this repo does not depend on, and it renders a raw `img`, links with a bare anchor and
misnames `Template.tsx`. Typechecking or linting it would report exactly the flaws it exists to
carry.

It is never built and never run. It is only read.

## The raw images, and which of them the project exempted

Three raw `img` elements, and the difference between them is the case:

- `app/galeria/page.tsx` carries no lint directive, so `components/image` names it. This is the row
  the corpus has always asserted, and it does not move.
- `app/editor/NodoImagen.tsx` opens with `/* eslint-disable @next/next/no-img-element */`. A rich
  text node view renders whatever the document holds; the project turned the rule off for the file
  and the condition honours that.
- `app/subida/Vista.tsx` holds two: one behind an `eslint-disable-next-line` for the same rule, one
  behind nothing. The file stays named, because a line-scoped exemption covers its line and no more.

Pinned to that shape. Renaming the rule in either directive, or widening one to a blanket
`/* eslint-disable */`, makes the exempted elements reportable again and fails the corpus case —
which is the point: the exemption is per rule, and a blanket disable names none.

## What it is pinned to

Most cases here are isolated to their own route segment. Five are not: they read the whole project,
and depend on it staying the shape it is. These are asserted directly in `corpus.test.ts`, so a
later case that took one away fails there instead of silently making a condition stop firing.

- **No route group under `app/`**, and eighteen sibling segments, so `route-groups` can argue for
  one. The figure was written as fifteen and had drifted to seventeen before `app/api/` was added;
  what the condition needs is that it stays above the threshold, not that it is any one number.
- **No `public` directory**, so `public-folder` can argue for one.
- **`@next/mdx`, `@opentelemetry/api` and `@vercel/analytics` declared** with none of the root files
  they argue for. Declared, never installed: the manifest is read, and this project has no
  `node_modules`.

`app/busqueda/page.tsx` carries `Form`: a raw form navigating to a path it names, with its fields
as search parameters. Its three negatives sit together in `app/envio/page.tsx` — a server-action
form, a computed action and a form that posts — so the case above cites one file.

`app/articulo/[slug]/page.tsx` carries the narrowed metadata shape: a page under a dynamic segment
with no metadata of its own and none above it. Its two negatives sit under `app/catalogo/`, whose
`layout.tsx` states the title — so `[id]/page.tsx` is not the shape, and `page.tsx` beside it is
under no dynamic segment at all. Adding metadata to the root layout would silence all three.

`app/galeria/page.tsx` backs two cases rather than one — its raw `img` is both an unadopted `Image`
component and an absolute asset path. It silences neither, but an edit to it now breaks two.

`app/api/salud/route.ts` is the only route handler here, and it is what makes the sitemap condition
falsifiable. Every other URL this project answers on is rendered by a page, so a reading that
counted endpoints and one that did not would report the same figure, and the assertion on it would
pass against either. With the handler present the two readings differ by one, which is what the
corpus test pins. Removing it does not break a condition; it breaks the test's ability to notice.

## What it cannot carry

`robots` fires when a sitemap exists and no robots file announces it. `sitemap` fires when there is
no sitemap and the project serves two or more routes. One project cannot satisfy both, so this one
carries `sitemap`. **`robots` is carried by `sparse-app`**, which is the case elsewhere this file
used to promise.

`connection` is the second. It fires when a file imports `unstable_noStore` and cache components
are **off**; this project has them on for `use cache`, which sends the same suggestion to `io`.
**`sparse-app` carries `connection`**, whose config is bare, so both sides are now covered against a
real project as well as synthetically in `functions.test.ts`.
