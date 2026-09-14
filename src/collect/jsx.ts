import ts from "typescript";

/**
 * An attribute value we were willing to read. Anything that is not a string literal —
 * an expression, a boolean shorthand, a spread — is `unresolved`, and a rule that needs
 * a literal simply does not fire rather than guessing.
 */
export type JsxAttributeValue = { readonly literal: string } | "unresolved";

export type JsxElementRecord = {
  /** `img`, `Image`, `Foo.Bar`. Fragments contribute no record at all. */
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, JsxAttributeValue>;
  /**
   * The 1-based line the opening tag starts on, which is what a line-scoped lint directive names.
   * A reading that has to ask whether an element is exempted needs to know which line it is on, and
   * nothing else in this record says.
   */
  readonly line: number;
};

/**
 * Built from the AST rather than with `getText()`: the source file is parsed without
 * parent pointers, so `getText()` throws on anything but a top-level node.
 */
function tagNameOf(name: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPropertyAccessExpression(name)) {
    const left = ts.isIdentifier(name.expression)
      ? name.expression.text
      : tagNameOf(name.expression as ts.JsxTagNameExpression);
    return left === undefined ? undefined : `${left}.${name.name.text}`;
  }
  return undefined;
}

function attributeName(attribute: ts.JsxAttribute): string | undefined {
  const { name } = attribute;
  if (ts.isIdentifier(name)) return name.text;
  // Namespaced attributes such as xlink:href keep their full name.
  return `${name.namespace.text}:${name.name.text}`;
}

function attributeValue(attribute: ts.JsxAttribute): JsxAttributeValue {
  const { initializer } = attribute;
  // A bare attribute like `fill` has no initializer: present, but with no literal to read.
  if (!initializer) return "unresolved";
  if (ts.isStringLiteral(initializer)) return { literal: initializer.text };
  if (ts.isJsxExpression(initializer) && initializer.expression) {
    const { expression } = initializer;
    if (ts.isStringLiteral(expression)) return { literal: expression.text };
    if (ts.isNoSubstitutionTemplateLiteral(expression)) return { literal: expression.text };
    // A boolean written down is a value the author wrote, the same as a string. `prefetch={false}`
    // is how the framework's own examples turn an attribute off, and reading it as unresolved
    // would leave a rule unable to tell it from an attribute nobody set.
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return { literal: "true" };
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return { literal: "false" };
  }
  return "unresolved";
}

function recordOf(
  source: ts.SourceFile,
  opening: ts.Node,
  tagName: ts.JsxTagNameExpression,
  attributes: ts.JsxAttributes,
): JsxElementRecord | undefined {
  const tag = tagNameOf(tagName);
  if (tag === undefined) return undefined;

  const collected = new Map<string, JsxAttributeValue>();
  for (const property of attributes.properties) {
    // A spread carries attributes we cannot enumerate, so it contributes nothing.
    if (!ts.isJsxAttribute(property)) continue;
    const name = attributeName(property);
    if (name === undefined) continue;
    collected.set(name, attributeValue(property));
  }
  // 1-based, because that is how an editor and a lint directive both count.
  const line = ts.getLineAndCharacterOfPosition(source, opening.getStart(source)).line + 1;
  return { tag, attributes: collected, line };
}

/**
 * Collects the JSX a file renders. Because this reads parsed syntax, an element written
 * inside a comment or a string literal never appears — which is the whole reason the
 * component heuristics live here rather than on file text.
 */
export function collectJsx(source: ts.SourceFile): JsxElementRecord[] {
  const elements: JsxElementRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node)) {
      const record = recordOf(source, node, node.tagName, node.attributes);
      if (record) elements.push(record);
    } else if (ts.isJsxElement(node)) {
      const { openingElement } = node;
      const record = recordOf(
        source,
        openingElement,
        openingElement.tagName,
        openingElement.attributes,
      );
      if (record) elements.push(record);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return elements;
}

/**
 * Files whose findings describe a test rather than what the project renders in production.
 *
 * The suffix may name what the test exercises rather than only that it is one: `api.servertest.ts`
 * is a test of the server, and reading it as production code puts suggestions on a file nobody
 * ships. Measured: langfuse names 389 files this way. The dot before the suffix is what keeps
 * `latest.ts` out.
 */
export function isTestFile(path: string): boolean {
  return (
    /\.(test|spec|servertest|clienttest|browsertest)\.[cm]?[jt]sx?$/.test(path) ||
    path.includes(`${"/"}__tests__${"/"}`) ||
    path.includes(`${"/"}e2e${"/"}`)
  );
}

export function attributeLiteral(element: JsxElementRecord, name: string): string | undefined {
  const value = element.attributes.get(name);
  return value !== undefined && value !== "unresolved" ? value.literal : undefined;
}

export function hasAttribute(element: JsxElementRecord, name: string): boolean {
  return element.attributes.has(name);
}

/**
 * Whether an attribute value names a path this project serves. The second character is what
 * decides it: `//host/path` starts with a slash and belongs to another origin, so a reading that
 * stopped at the first one would treat a link to somebody else's site as an internal route.
 */
export function isInternalPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

/**
 * The lint rules a file turns off, indexed the way a reader has to ask about them.
 *
 * A project's own lint configuration is a decision it already made, and a suggestion arguing
 * against it is arguing with the author rather than telling them something. Reading the directives
 * is how a condition can tell "nobody considered this" from "somebody considered it and said no".
 *
 * Read off the source text rather than the AST: a directive is a comment, and comments are trivia
 * that the parser attaches to whichever node follows — which for a file-wide disable before an
 * import is a different node from the one a JSX element sits under. Scanning lines answers both
 * scopes with one pass and no dependence on where the parser hung the trivia.
 *
 * A directive naming no rule is deliberately indexed under nothing. `/* eslint-disable *\/` with no
 * rule is a blanket the author may not have meant to cover this rule at all, and crediting it would
 * silence a finding on the strength of a decision nobody made about it.
 */
export type LintSuppressions = {
  /** Rules disabled for the whole file. */
  readonly fileWide: ReadonlySet<string>;
  /** Rules disabled on a given 1-based line, whether named there or on the line above. */
  readonly byLine: ReadonlyMap<number, ReadonlySet<string>>;
};

export const NO_SUPPRESSIONS: LintSuppressions = { fileWide: new Set(), byLine: new Map() };

/** The rule names a directive lists, or nothing where it names none. */
function rulesIn(list: string | undefined): readonly string[] {
  if (list === undefined) return [];
  return list
    .split(",")
    .map((rule) => rule.trim())
    .filter((rule) => rule !== "");
}

function addTo(index: Map<number, Set<string>>, line: number, rules: readonly string[]): void {
  if (rules.length === 0) return;
  const existing = index.get(line) ?? new Set<string>();
  for (const rule of rules) existing.add(rule);
  index.set(line, existing);
}

/**
 * Reads the ESLint disable directives a file carries.
 *
 * Three forms, and they are the ones the rule this serves is written with: a file-wide
 * `eslint-disable` in the leading comments, an `eslint-disable-line` on the element's own line, and
 * an `eslint-disable-next-line` on the line above. A file-wide directive is only read before the
 * first statement, because that is where ESLint itself honours it.
 */
export function readLintSuppressions(text: string): LintSuppressions {
  const fileWide = new Set<string>();
  const byLine = new Map<number, Set<string>>();
  const lines = text.split(/\r?\n/);

  let inPrologue = true;
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmed = raw.trim();

    if (inPrologue) {
      const fileDirective = /^\/\*\s*eslint-disable\s*([^*]*?)\s*\*\//.exec(trimmed);
      if (fileDirective !== null) {
        for (const rule of rulesIn(fileDirective[1])) fileWide.add(rule);
        continue;
      }
      // The prologue ends at the first line that is neither blank nor a comment: a file-wide
      // directive written after code is not one ESLint honours either.
      const isTrivia =
        trimmed === "" ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("'use ") ||
        trimmed.startsWith('"use ');
      if (!isTrivia) inPrologue = false;
    }

    const sameLine = /\/\/\s*eslint-disable-line\s*(.*)$/.exec(raw);
    if (sameLine !== null) addTo(byLine, line, rulesIn(sameLine[1]));

    const nextLine = /\/\/\s*eslint-disable-next-line\s*(.*)$/.exec(raw);
    if (nextLine !== null) addTo(byLine, line + 1, rulesIn(nextLine[1]));
  }

  return { fileWide, byLine };
}

/** Whether the rule is turned off for that line, by either scope. */
export function suppressesAt(suppressions: LintSuppressions, rule: string, line: number): boolean {
  return suppressions.fileWide.has(rule) || (suppressions.byLine.get(line)?.has(rule) ?? false);
}
