# global-not-found-app

The fifth vendored project, and the smallest. It exists for one convention that no other fixture
can hold.

## Why it could not go anywhere else

`global-not-found` needs a project that **adopts** it, and adopting it changes what a second
condition reports. A root `global-not-found` file catches a `notFound()` call anywhere in the
project, exactly as a root `not-found` file does — the installed documentation says both *"handle
any unmatched URLs for your whole application"*. So the file cannot be added to a project pinned to
having an uncaught call.

- `incomplete-app` is pinned to exactly that: its `file-conventions/not-found` case is an uncaught
  `notFound()` in `app/ausente/page.tsx`, and this file would silence it.
- `sparse-app` is pinned to an empty `next.config.ts`, and this convention needs a flag on.
- `unflagged-app` is pinned to setting none of the options its code argues for, which is the
  opposite case: it holds `app/global-not-found.tsx` with the flag **off**, where Next.js does not
  run the file and the convention is not adopted.
- `overconfigured-app` is pinned to configuring the options nothing else configures, which is about
  the configuration surface rather than about a route convention.

## What it is pinned to

**`experimental.globalNotFound` on, and a root `global-not-found` file.** Together they are the
convention being adopted. Turning the flag off, or renaming the file, is the negative case and
belongs in `unflagged-app`.

**No `not-found` file, anywhere.** The point of the project is that the *other* root file is what
catches the call. A `not-found.tsx` added here would cover the call for the ordinary reason and the
case would pass without testing anything.

**A `notFound()` call in a segment no `not-found` covers.** `app/informe/page.tsx` makes it. This is
the call whose coverage the change is about, and before it the entry argued for a `not-found` file
beside a `global-not-found` one the configuration enables.

## What it shares with the other four

It is vendored, committed, and runs on a fresh clone. It is read and never built or run. It is
excluded from this repo's `tsconfig.json` and `biome.json`, because linting a project written to
carry a shape under test would report the shape. Every file names in a comment what it is there for.

## What the version documents

Neither 16.3.0 nor 16.2.6 gives `global-not-found` a page of its own — the convention is described
inside `not-found.md`. The catalog derives its entries from pages, so the entry this project adopts
is reported in the count of APIs this tool detects and the installed version does not document,
rather than in a bucket. The convention is still resolved, and still covers the call: what the
missing page withholds is the entry, not the reading.
