# overconfigured-app

A Next.js project that **configures what nothing else configures**. Its code was beside the point
until one case needed it: it now also carries the unflagged half of a flag split, and the pages
under `app/datos`, `app/declarado` and `app/interactivo` exist for that one condition.

`incomplete-app` is missing files. `sparse-app` is missing structure. `unflagged-app` is missing
configuration. This one is the mirror of the third: it sets the thirty-two option pages that still
carry the derived group reason and whose name is a key `NextConfig` accepts. Until it existed, no
project in the corpus set any of them, so the inverse reading had no value to read and the
examination queue could not start.

## What it is for

An option nobody configures cannot be examined: every condition written so far came from reading a
configured value against what the framework already does, and that reading needs a value.

**This is a source of readable values, not a statement of priority.** Nobody chose to set these
options — this project sets them so a condition over them can be written and proven to fire. What
deserves examining first still comes from the real projects, where a set option means somebody
wanted it. `EXAMINATION_TRANCHES` in `src/catalog/config.ts` keeps the two apart.

## The five pages it does not set

These option pages exist in the derived surface for 16.3.0, but their name is not a key of
`NextConfig` at the root or under `experimental`. Detection builds its lookup from the page name,
so **no project can report them as used**, whatever it configures. Setting them here under the key
the framework really accepts would make this file valid and change nothing.

| page | writable key |
| --- | --- |
| `appDir` | none — no longer in the type |
| `incrementalCacheHandlerPath` | `cacheHandler` |
| `staticGeneration` | `experimental.staticGenerationRetryCount`, `...MaxConcurrency`, `...MinPagesPerWorker` |
| `turbopackFileSystemCache` | `experimental.turbopackFileSystemCacheForDev`, `...ForBuild` |
| `turbopackIgnoreIssue` | `turbopack.ignoreIssue` |

That is a gap in detection, not a gap in this fixture. `staticGeneration` is why it needs its own
proposal rather than a rename: one page covers three keys, so what *used* means for it has to be
decided before anything can map a page to a key.

`cacheHandlers` — plural, the `use cache` handlers — is a different option, is a writable key, and
is set. The two were checked for exclusivity and found independent.

## The options it sets and cannot exercise

Set on purpose, and inert under this project's shape. Presence is what the derived predicate reads,
so an option the bundler ignores is still an option this project makes readable. Listed here so an
inert option is not read as a broken one.

- **`exportPathMap`** — Pages Router, and this is an App Router project.
- **`useLightningcss`** — webpack only, and this project's `build` script passes `--turbopack`,
  which ignores it. The script is declared and never run: nothing here is built. What it is for is
  putting the bundler where something can read it, since a claim in a comment is not a claim the
  analysis can check — and the constraint over bundler scope reports this option because of it.
- **`turbopackMemoryEviction`** — needs the filesystem cache to have an effect, and the filesystem
  cache is one of the five pages above.

## The one case that reads its code

| file | condition | what makes it fire |
| --- | --- | --- |
| `app/datos/page.tsx` | `fetch` | a server-side call carrying neither `cache` nor `next`, with `cacheComponents` unset |
| `lib/existencias.ts` | `fetch` | the same call in a helper outside the route tree, reached by the import in `app/almacen/page.tsx` |
| `app/declarado/page.tsx` | — | the negatives: `no-store`, another `cache` value, a `next` option, and options built elsewhere |
| `app/interactivo/panel.tsx` | — | the same plain call on the client side, where the framework's extension does nothing |
| `scripts/sincronizar.ts` | — | the same plain call in a Node script run by a `package.json` line, which nothing the app imports reaches |
| `docs/manual/soporte.js` | — | the same plain call in a browser bundle beside the docs, which nothing the app imports reaches |

The last two carry no signal one read of a file can see — no shebang, no `process.argv`, no client
directive — and both shapes have been cited as server-side calls in real projects. What keeps them
out is that the framework runs only what its route tree and its root files reach.

One shape, two entries, and the flag decides which answers. `unflagged-app` holds the same page
with `cacheComponents` on, where the cache directive carries it — see
`app/informes/page.tsx` there, and `src/catalog/directives.test.ts` for the pair asserted against
each other.

## What it is pinned to

Whole-project properties, asserted directly in `corpus.test.ts` so a later edit that takes one away
fails there instead of silently stopping a condition from firing.

- **`next.config.ts` names every one of the thirty-two options.** Asked of the configuration
  through `readFlag`, never by grepping the file text: the comments here name the very options they
  exist to discuss, so reading the text would answer differently.
- **It names none of the five pages above**, under any spelling. Setting one would claim a
  detectability that does not exist.
- **`cacheComponents` is unset.** It is the unflagged side of the split above; turning it on here
  would silence the `fetch` case and make the cache directive answer twice across the corpus.
- **No `node_modules`.** Like the other three vendored projects, and here it costs the same thing
  it costs `unflagged-app`: a condition reading what the installed Next.js applies by default has
  nothing to read, so it correctly goes quiet. Those conditions are proven against a temporary
  project carrying a minimal `next`, in `config.test.ts`, not here.

## The rules it follows

It is vendored rather than referenced, which is the opposite of the three real fixtures and for the
opposite reason: they must drift with their real dependencies, and this one must not move at all.
It is committed, so it runs on a fresh clone where the others are skipped for absence.

It is excluded from `tsconfig.json` and `biome.json`. Its configuration is typechecked out of band
against a real installed Next 16.3.0 instead — nothing is installed here, and nothing is built.

It is never built and never run. It is only read.
