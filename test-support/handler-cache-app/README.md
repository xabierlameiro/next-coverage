# handler-cache-app

A project that **configures a custom cache handler and no cache size**.

That pair is the whole fixture. The page titled `incrementalCacheHandlerPath` — the key is
`cacheHandler`, a rename the page did not follow — asks for `cacheMaxMemorySize` to be `0` when a
handler is adopted, so reads reach the handler's store rather than a per-instance copy. A project
holding the handler and leaving the size alone is what that condition reports on.

## Why it is its own project

`overconfigured-app` is pinned to the opposite case. The same page carries a condition arguing that
a project *without* a handler could adopt one, and its case lives there. Putting the handler in that
fixture silences it, which is how this fixture came to exist: the two conditions want opposite
project properties, and a contradiction between two conditions is a reason to add a project rather
than to leave one uncovered.

## What it deliberately does not have

- **`cacheMaxMemorySize`**, in any value. Setting it to `0` is the state the page asks for and
  silences the condition; setting it to anything else would still fire, and the absent case is the
  one the page describes first.
- **`cacheHandlers`**, the plural. A different option, whose own page says the handler it registers
  manages its own memory and that `cacheMaxMemorySize` no longer applies to it. A fixture holding
  both keys would not say which of the two the condition reads, and they differ by one character.
- Anything else. Every other option absent here is absent so that a second condition cannot fire on
  this project by accident and be read as this one.
