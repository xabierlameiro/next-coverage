import { readFileSync } from "node:fs";
import { join } from "node:path";

/** An entry naming exactly one directory: `name`, `/name`, `name/` or `/name/`, and nothing else. */
const PLAIN_DIRECTORY = /^\/?[^/*?]+\/?$/;

/**
 * The directories a project says it does not version, read from the `.gitignore` at its root.
 *
 * Generated output is not the project's source, and a project that generates any already records
 * where it lands. Reading that is the same move the catalog makes against the installed
 * documentation: take what the project already states rather than keep a list of tool names that
 * needs a line every time somebody adopts another reporter.
 *
 * Four shapes are read and everything else is refused, which is the honest half. An entry carrying
 * a wildcard or an interior separator names something this reader cannot resolve to one directory,
 * and a name re-included by a negation is not a directory the project calls generated. Both are
 * left out of the result, so the directory is walked — reading one generated file costs a figure,
 * and skipping one real source file costs an answer.
 *
 * Only the root file is read. A `.gitignore` in a subdirectory is not, and this does not claim the
 * boundary is complete.
 *
 * It sits in a module of its own because both readers that need it — the source scan and the
 * discovery that looks below a root declaring nothing — would otherwise import each other.
 */
export function unversionedDirectories(root: string): ReadonlySet<string> {
  let text: string;
  try {
    text = readFileSync(join(root, ".gitignore"), "utf8");
  } catch {
    return new Set();
  }
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  const reincluded = new Set(
    entries
      .filter((entry) => entry.startsWith("!"))
      .map((entry) => entry.slice(1).replace(/^\/|\/$/g, "")),
  );

  const named = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith("!") || !PLAIN_DIRECTORY.test(entry)) continue;
    const name = entry.replace(/^\/|\/$/g, "");
    if (name === "" || reincluded.has(name)) continue;
    named.add(name);
  }
  return named;
}
