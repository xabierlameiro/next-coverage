import ts from "typescript";

/** A literal we could read, or a marker that the value is not knowable statically. */
export type CallArgument = { readonly literal: string } | "unresolved";

export type CallRecord = {
  /**
   * The local name at the call site, resolved to its import by the ledger. The namespace where
   * `member` is set, and the exported name itself where `from` is.
   */
  readonly callee: string;
  /** The export called off a namespace: `revalidateTag` in `cache.revalidateTag()`. */
  readonly member?: string;
  /** The module, where the call is made on the import itself and binds no name. */
  readonly from?: string;
  readonly args: readonly CallArgument[];
  /**
   * Tags carried by an options argument rather than by a positional one. Kept apart from `args`
   * because flattening them in would make an option indistinguishable from a key.
   */
  readonly optionTags: readonly CallArgument[];
};

/**
 * The string literals a file settles on its own: a name declared once as a `const` with a literal
 * initialiser and never assigned again. A name the file declares twice, shadows in an inner scope,
 * imports, or reassigns is absent, because one file cannot settle it.
 *
 * Refusing every such case costs a value that stays unresolved and disclosed. Guessing at one would
 * report a tag nobody wrote, which is the failure this tool does not accept.
 */
export type FileConstants = ReadonlyMap<string, string>;

export function fileConstants(source: ts.SourceFile): FileConstants {
  const values = new Map<string, string>();
  const refused = new Set<string>();
  const declare = (name: string, literal: string | undefined): void => {
    if (values.has(name) || refused.has(name) || literal === undefined) {
      values.delete(name);
      refused.add(name);
      return;
    }
    values.set(name, literal);
  };

  // The list carries the `const` flag, and the scan parses without parent pointers, so the
  // declarations are read from the list rather than from each declaration's parent.
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node)) {
      const isConst = (node.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of node.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initialiser = declaration.initializer;
        const literal =
          isConst &&
          initialiser !== undefined &&
          (ts.isStringLiteral(initialiser) || ts.isNoSubstitutionTemplateLiteral(initialiser))
            ? initialiser.text
            : undefined;
        declare(declaration.name.text, literal);
      }
    } else if (ts.isCatchClause(node)) {
      const caught = node.variableDeclaration?.name;
      if (caught && ts.isIdentifier(caught)) declare(caught.text, undefined);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      declare(node.name.text, undefined);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      declare(node.name.text, undefined);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      declare(node.left.text, undefined);
    } else if (ts.isImportSpecifier(node)) {
      declare(node.name.text, undefined);
    } else if (ts.isImportClause(node)) {
      if (node.name) declare(node.name.text, undefined);
    } else if (ts.isNamespaceImport(node)) {
      declare(node.name.text, undefined);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return values;
}

export function literalArgument(node: ts.Expression, constants?: FileConstants): CallArgument {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { literal: node.text };
  }
  if (constants && ts.isIdentifier(node)) {
    const literal = constants.get(node.text);
    if (literal !== undefined) return { literal };
  }
  return "unresolved";
}

/** Array elements are read one by one, so one computed element does not lose the rest. */
export function argumentsOf(call: ts.CallExpression, constants?: FileConstants): CallArgument[] {
  return call.arguments.flatMap((argument) =>
    ts.isArrayLiteralExpression(argument)
      ? argument.elements.map((element) => literalArgument(element, constants))
      : [literalArgument(argument, constants)],
  );
}

/**
 * The `cache` value of `fetch(url, { cache: '…' })`, read whether or not the call also carries the
 * framework's `next` option: the two answer different questions, and a project may write either
 * alone. A value that is not a string literal comes back unresolved rather than dropped, so a
 * condition can decline while a count of calls stays true.
 */
export function fetchCacheOf(call: ts.CallExpression): CallArgument | undefined {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (!ts.isIdentifier(property.name) || property.name.text !== "cache") continue;
    return literalArgument(property.initializer);
  }
  return undefined;
}

/**
 * The `tags` array inside the options argument of `unstable_cache(fn, keyParts, { tags: [...] })`.
 * Deprecated or not, a project running it produces the tags it names, and a ledger that did not
 * read them would report every invalidation of one as naming a tag nobody produces.
 *
 * A call with no options argument carries no tags to lose, so it contributes nothing rather than
 * an unresolved value.
 */
export function optionTagsOf(call: ts.CallExpression, constants?: FileConstants): CallArgument[] {
  const options = call.arguments[2];
  if (!options || !ts.isObjectLiteralExpression(options)) return [];
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (!ts.isIdentifier(property.name) || property.name.text !== "tags") continue;
    return ts.isArrayLiteralExpression(property.initializer)
      ? property.initializer.elements.map((element) => literalArgument(element, constants))
      : ["unresolved"];
  }
  return [];
}

/** The `tags` array inside `fetch(url, { next: { tags: [...] } })`. */
export function fetchTagsOf(call: ts.CallExpression, constants?: FileConstants): CallArgument[] {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return [];
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (!ts.isIdentifier(property.name) || property.name.text !== "next") continue;
    if (!ts.isObjectLiteralExpression(property.initializer)) return ["unresolved"];
    for (const nested of property.initializer.properties) {
      if (!ts.isPropertyAssignment(nested)) continue;
      if (!ts.isIdentifier(nested.name) || nested.name.text !== "tags") continue;
      return ts.isArrayLiteralExpression(nested.initializer)
        ? nested.initializer.elements.map((element) => literalArgument(element, constants))
        : ["unresolved"];
    }
  }
  return [];
}

/**
 * Local names a file introduces through an import. Only calls to these are recorded:
 * the ledger anchors on import bindings anyway, and recording every call in the project
 * made a single run four times slower for data nothing reads.
 */
export function importedLocalNames(source: ts.SourceFile): Set<string> {
  const locals = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) locals.add(clause.name.text);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) locals.add(named.name.text);
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) locals.add(element.name.text);
    }
  }
  return locals;
}

function withoutParentheses(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? withoutParentheses(node.expression) : node;
}

/**
 * `await import('module')`, with the call and the module it names. Only the awaited form with a
 * literal specifier: what a promise is handed to, or what a computed specifier names, is not
 * something one file settles.
 */
export function awaitedImportOf(
  node: ts.Expression | undefined,
): { readonly call: ts.CallExpression; readonly specifier: string } | undefined {
  if (node === undefined) return undefined;
  const awaited = withoutParentheses(node);
  if (!ts.isAwaitExpression(awaited)) return undefined;
  const call = withoutParentheses(awaited.expression);
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) {
    return undefined;
  }
  const [specifier] = call.arguments;
  return specifier !== undefined && ts.isStringLiteral(specifier)
    ? { call, specifier: specifier.text }
    : undefined;
}

/**
 * The names a declaration takes off a module it was handed whole: `{ a, b: c }` binds two exports,
 * and a plain name binds the namespace. `unread` says the pattern holds something that names no
 * export — a rest element, a nested pattern, a computed key.
 */
export function namesTakenBy(name: ts.BindingName): {
  readonly bound: readonly { readonly imported: string; readonly local: string }[];
  readonly unread: boolean;
} {
  if (ts.isIdentifier(name)) return { bound: [{ imported: "*", local: name.text }], unread: false };
  if (!ts.isObjectBindingPattern(name)) return { bound: [], unread: true };
  const bound: { imported: string; local: string }[] = [];
  let unread = false;
  for (const element of name.elements) {
    const key = element.propertyName ?? element.name;
    const named = ts.isIdentifier(key) || ts.isStringLiteral(key);
    if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name) || !named) {
      unread = true;
      continue;
    }
    bound.push({ imported: key.text, local: element.name.text });
  }
  return { bound, unread };
}

/** The namespaces a file imports as values, by local name, with the module each one is. */
export function importedNamespaces(source: ts.SourceFile): Map<string, string> {
  const namespaces = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    if (!clause || clause.isTypeOnly || !named || !ts.isNamespaceImport(named)) continue;
    namespaces.set(named.name.text, statement.moduleSpecifier.text);
  }
  return namespaces;
}

/**
 * Whether an identifier stands for the value of its name, rather than being the name of a member,
 * a key or an attribute that happens to be spelled the same.
 */
export function standsForAValue(node: ts.Identifier, parent: ts.Node | undefined): boolean {
  if (parent === undefined) return true;
  if (ts.isNamespaceImport(parent)) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== node;
  if (ts.isBindingElement(parent)) return parent.propertyName !== node;
  if (ts.isJsxAttribute(parent)) return false;
  const declaresAMember =
    ts.isPropertyAssignment(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isMethodDeclaration(parent);
  return !(declaresAMember && parent.name === node);
}
