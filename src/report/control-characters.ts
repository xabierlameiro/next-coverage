/**
 * What a terminal acts on instead of printing, and what reorders the text around it.
 *
 * C0 and C1 carry the escape that starts a terminal sequence, the carriage return that overwrites
 * a line and the line feed that starts one. The bidirectional controls move nothing and change the
 * order a line is read in, which is the same fault by another route: a name that does not read as
 * what it is.
 */
function isControl(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** The text with each control character written out as the escape that names it. */
export function spellControls(text: string): string {
  let spelled = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    spelled += isControl(code) ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return spelled;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function respelled(value: unknown): unknown {
  if (typeof value === "string") return spellControls(value);
  if (Array.isArray(value)) return value.map(respelled);
  if (value instanceof Set) return new Set([...value].map(respelled));
  if (value instanceof Map) {
    return new Map([...value].map(([key, held]) => [respelled(key), respelled(held)]));
  }
  if (typeof value !== "object" || value === null || !isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, held]) => [spellControls(key), respelled(held)]),
  );
}

/**
 * The same value with every string in it safe to print.
 *
 * A path, an attribute or a specifier is text the analysed project wrote, and the terminal report
 * prints it as it came. An escape in a file name moved the cursor, a line feed in one added a line
 * to the report that the tool never wrote, and either lets a project edit what is said about it.
 * The JSON needs none of this: `JSON.stringify` escapes the same characters.
 *
 * Done to what the renderer is given rather than to what it returns, because by then the
 * project's line feed and the report's own are the same character.
 */
export function spellingControls<T>(value: T): T {
  // The one cast: the walk returns the shape it was given with its strings respelled, and a shape
  // cannot be followed through a walk over `unknown`.
  return respelled(value) as T;
}
