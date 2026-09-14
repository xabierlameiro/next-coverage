# unflagged-app

A Next.js project whose **code is written and whose switches are off**. Nothing here is an
oversight.

`incomplete-app` is missing files. `sparse-app` is missing structure. This one is missing
*configuration*: every case below is code that Next.js already ignores, and a project cannot at
once enable an option and argue for it. That is why these six cases cannot live in either of the
other two, and why the three real fixtures — all thoroughly configured — could never show them.

## The cases

| file | condition | what makes it fire |
| --- | --- | --- |
| `app/forbidden.tsx` | `authInterrupts` | the convention is on disk and skipped, because the flag is unset |
| `app/unauthorized.tsx` | `authInterrupts` | the same, so the condition has to report both rather than the first |
| `app/global-not-found.tsx` | `globalNotFound` | the convention is on disk and skipped, so it is neither adopted here nor catching anything |
| `app/sincronizacion/estado-red.tsx` | `useOffline` | imports `next/offline` with the flag unset, so the hook always returns false |
| `app/manifest.ts` | `app-icons` | names `/logo-512.png`, which nothing provides |
| `app/remoto/page.tsx` | `urlImports` | imports from `https://esm.sh`, which resolves nowhere with the option unset |
| `app/informes/page.tsx` | `'use cache'` | a server-side fetch carrying neither `cache` nor `next`, with `cacheComponents` on |
| `app/informes/historico.ts` | `'use cache'` | imports `unstable_cache`, the second reason, so the verdict has to keep each reason's files apart |
| `app/preferencias/page.tsx` | `'use cache: private'` | a cache scope importing `cookies` from `next/headers` |
| `app/privado/page.tsx` | — | the negative: the same read in a scope that already carries the private variant |
| `app/mixto/page.tsx` | — | the negative: a cached scope and a request read in two different functions of one file |

## What it is pinned to

These are whole-project properties, asserted directly in `corpus.test.ts` so a later edit that
takes one away fails there instead of silently stopping a condition from firing.

- **`next.config.ts` sets none of `authInterrupts`, `useOffline`, `urlImports` or a `cacheLife`
  profile.** Adding any of them silences its case.
- **`cacheComponents` is on**, because `'use cache'` needs it — and because that makes this the
  flagged side of a split. One shape, a server fetch stating nothing about its caching, is carried
  by the cache directive here and by the extended `fetch` in `overconfigured-app`, which leaves the
  flag unset. Turning it off here would move the case rather than remove it, which is why both
  sides are pinned.
- **No image convention anywhere.** No `icon.*`, no `apple-icon.*`, no `favicon.*`, no
  `opengraph-image.*`. This is also the only project in the corpus where
  `generate-image-metadata`'s prerequisite can be seen to hold.
- **No `node_modules`.** Like the other two vendored projects, and it costs one case: the
  `cacheLife` condition reads the built-in profile names out of the installed package, so with
  nothing installed the list is unresolved and the condition correctly goes quiet. That condition
  is proven against a temporary project carrying a minimal `next` instead, in `config.test.ts`.
  Adding a case for it here would add a file that exercises nothing.
- **`public/logo-192.png` exists and `public/logo-512.png` does not.** Both halves matter. The
  manifest names both, and a condition checking only the metadata conventions would report the
  first — which is served from `public/` and therefore provided. That false positive was already
  measured on a real project before this fixture existed, and this pins it.

## The rules it follows

It is vendored rather than referenced, which is the opposite of the three real fixtures and for the
opposite reason: they must drift with their real dependencies, and this one must not move at all.
It is committed, so it runs on a fresh clone where the others are skipped for absence.

It is excluded from `tsconfig.json` and `biome.json`. It imports `next/offline` and `next/cache`,
which this repo does not depend on. Typechecking or linting it would report exactly the state it
exists to carry.

It is never built and never run. It is only read.
