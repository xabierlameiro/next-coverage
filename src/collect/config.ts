import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { DEFAULT_PAGE_EXTENSIONS, type Resolved, resolved, unresolved } from "../types.js";

const CONFIG_FILENAMES = [
  "next.config.ts",
  "next.config.mts",
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
] as const;

/** A literal value we were willing to read out of next.config. */
export type ConfigLiteral = string | number | boolean | null;

export type NextConfigSource = {
  readonly path: string;
  readonly object: Resolved<ts.ObjectLiteralExpression>;
  /**
   * For each name the file imports from a workspace package, the keys of the object literal that
   * package exports under it — so a configuration spreading a shared base states, through this,
   * what that base can contribute.
   */
  readonly importedObjects: ReadonlyMap<string, readonly string[]>;
};

/**
 * How a package specifier written in the config becomes a directory on disk.
 *
 * Injected rather than resolved here: knowing which directory holds `@repo/next-config` means
 * knowing the workspace, and the module that knows it already depends on this one. The reader asks
 * a question and the caller answers it, which keeps the dependency pointing one way.
 */
export type PackageDirectoryResolver = (specifier: string) => string | undefined;

/** Strips parentheses, `as T` and `satisfies T` so the payload underneath is reachable. */
function unwrapTypeSyntax(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * The value a `const <name> = <value>` binds, searched over one list of statements. Returns the
 * initialiser rather than requiring an object, so a name bound to a wrapper call can be unwrapped
 * by the caller the same way the default export is.
 *
 * A name declared more than once in the same list is refused outright: two declarations mean the
 * file settles nothing this reader can follow, and picking one would resolve a config the project
 * may not have.
 */
function valueDeclaredAs(
  statements: readonly ts.Statement[],
  name: string,
): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (!declaration.initializer) continue;
      if (found !== undefined) return undefined;
      found = unwrapTypeSyntax(declaration.initializer);
    }
  }
  return found;
}

/**
 * Whether the statements assign to `name` after declaring it, which makes the name unfollowable.
 *
 * Every assignment operator counts, not only `=`. `name ??= fallback` and `name ||= other` rebind
 * the name exactly as plainly, and reading only `=` would follow a declaration the file goes on to
 * replace — the one direction this reader must not err in, since a name followed to the wrong value
 * reports a configuration nobody wrote.
 *
 * A destructuring target counts wherever the name appears inside it. That over-refuses — a computed
 * key mentioning the name is not an assignment to it — and over-refusing is the safe half: the cost
 * is a config left unread and said to be, against a config read wrong and reported as fact.
 */
function assignsTo(statements: readonly ts.Statement[], name: string): boolean {
  const namesTarget = (target: ts.Node): boolean => {
    if (ts.isIdentifier(target)) return target.text === name;
    if (!ts.isObjectLiteralExpression(target) && !ts.isArrayLiteralExpression(target)) return false;
    let mentioned = false;
    const walk = (node: ts.Node): void => {
      if (mentioned) return;
      if (ts.isIdentifier(node) && node.text === name) mentioned = true;
      else ts.forEachChild(node, walk);
    };
    ts.forEachChild(target, walk);
    return mentioned;
  };

  // The whole assignment family, taken as the range the enum declares it as rather than as a list
  // of fifteen tokens: `ts.isAssignmentOperator` is not part of the published API, and a list would
  // silently miss whichever operator the language adds next.
  const assigns = (kind: ts.SyntaxKind): boolean =>
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

  let assigned = false;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && assigns(node.operatorToken.kind) && namesTarget(node.left)) {
      assigned = true;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of statements) visit(statement);
  return assigned;
}

/**
 * Whether every assignment to `name` merely applies a plugin to it, leaving the configuration it
 * was declared with the configuration it holds.
 *
 * `polarsource/polar` chains its plugins this way — `let conf = withMDX(nextConfig)` and then
 * `conf = withSentryConfig(conf, { … })` — which is the ordinary shape once there are more than
 * two of them. Applying a plugin to a configuration does not replace it, a fact this reader already
 * acts on where one branch of a conditional wraps and the other does not.
 *
 * An assignment wraps where it is a call carrying the assigned name, judged by the rule
 * `unwrapWrappers` uses: the carried value is the first argument not written as a function.
 * Everything else keeps the refusal. `conf = makeOther()` replaces it outright, and
 * `conf = { ...conf, cacheComponents: false }` names it while stating a different configuration —
 * reading past that one would report a value the project overrode as the value it configured, which
 * is the one direction this reader must not err in.
 *
 * No statement order is read and no flow is simulated. The claim is only that where every
 * assignment wraps, unwrapping reaches the declaration's literal whichever assignment ran.
 */
function onlyWrapsItself(statements: readonly ts.Statement[], name: string): boolean {
  const mentions = (node: ts.Node, sought: string): boolean => {
    let found = false;
    const walk = (child: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(child) && child.text === sought) found = true;
      else ts.forEachChild(child, walk);
    };
    walk(node);
    return found;
  };

  const carries = (call: ts.CallExpression): boolean => {
    const carrier = call.arguments
      .map(unwrapTypeSyntax)
      .find((argument) => asFunction(argument) === undefined);
    return carrier !== undefined && ts.isIdentifier(carrier) && carrier.text === name;
  };

  const assigns = (kind: ts.SyntaxKind): boolean =>
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

  let wraps = 0;
  let other = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && assigns(node.operatorToken.kind)) {
      const target = unwrapTypeSyntax(node.left);
      if (ts.isIdentifier(target) && target.text === name) {
        const value = unwrapTypeSyntax(node.right);
        if (ts.isCallExpression(value) && carries(value)) wraps += 1;
        else other += 1;
      } else if (!ts.isIdentifier(target) && mentions(target, name)) {
        // A destructuring target `assignsTo` counts by mention, and this must agree with it or a
        // name that guard refuses would be followed here. It is not a wrapping and this reader has
        // no reading of it, so one is enough to keep the name refused.
        other += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of statements) visit(statement);
  return wraps > 0 && other === 0;
}

/**
 * The function the default export is, in any of the forms the language offers. The documentation
 * describes a config that is a function of `(phase, { defaultConfig })`, and a project writing one
 * is exporting a configuration like any other.
 */
function asFunction(
  node: ts.Node,
): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return node;
  }
  return undefined;
}

/**
 * Every expression the function returns, including a concise arrow body, and never one belonging to
 * a function nested inside it: a callback returns to its own caller, and reading that as the
 * configuration would take a value the framework never receives.
 */
function returnedExpressions(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): readonly ts.Expression[] {
  const body = fn.body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return [unwrapTypeSyntax(body)];

  const returned: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (asFunction(node) !== undefined && node !== fn) return;
    if (ts.isReturnStatement(node) && node.expression) {
      returned.push(unwrapTypeSyntax(node.expression));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return returned;
}

/** The statements a function's block body holds, for resolving a name declared inside it. */
function bodyStatements(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): readonly ts.Statement[] {
  return fn.body !== undefined && ts.isBlock(fn.body) ? [...fn.body.statements] : [];
}

type DefaultExport =
  | { readonly kind: "expression"; readonly expression: ts.Expression }
  | {
      readonly kind: "function";
      readonly fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
    };

/** The right-hand side of a top-level `module.exports = …`, or nothing for any other statement. */
function commonJsExport(statement: ts.Statement): ts.Expression | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const { expression } = statement;
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(expression.left)
  ) {
    return undefined;
  }
  const { expression: object, name } = expression.left;
  // Exactly `module.exports`, and nothing deeper. `module.exports.default` and `exports.default`
  // are a different claim about what the file exports, and guessing which one Next.js reads would
  // be reading a shape rather than measuring one.
  return ts.isIdentifier(object) && object.text === "module" && name.text === "exports"
    ? expression.right
    : undefined;
}

/**
 * The configuration the file exports, under either form the documentation shows.
 *
 * `export default` wins where both appear: a file carrying both is ambiguous, and the ES form is
 * the one every configuration in the documentation uses. Among `module.exports` assignments the
 * last wins, which is what CommonJS does at runtime — so the whole statement list is scanned rather
 * than returning at the first hit.
 *
 * `module.exports` was not read at all until a real project was found writing it in a TypeScript
 * config. Every option it set was invisible, and unresolved reads as absent to the catalog, so the
 * report argued for options the project already had on.
 */
function findDefaultExport(source: ts.SourceFile): DefaultExport | undefined {
  const readExpression = (node: ts.Expression): DefaultExport => {
    const expression = unwrapTypeSyntax(node);
    const fn = asFunction(expression);
    return fn ? { kind: "function", fn } : { kind: "expression", expression };
  };

  let commonJs: DefaultExport | undefined;
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return readExpression(statement.expression);
    }
    // `export default function config() {}` is a declaration carrying the modifiers, not an
    // assignment, so it never reached the reader that only looked for the latter.
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return { kind: "function", fn: statement };
    }
    const assigned = commonJsExport(statement);
    if (assigned !== undefined) commonJs = readExpression(assigned);
  }
  return commonJs;
}

/**
 * How many plugin wrappers the default export may be nested in. Wrappers stack in real
 * projects, but not without limit, and a bound keeps a hand-rolled export from being walked
 * forever. Exceeding it is unresolved, never guessed.
 */
const MAX_WRAPPER_DEPTH = 6;

/**
 * Peels plugin wrappers off the default export by following the argument that carries the config.
 *
 * Never the callee. `withBundleAnalyzer({ enabled })(withNextIntl(config))` is a call whose
 * callee is itself the call `withBundleAnalyzer({ enabled })` and whose argument is
 * `withNextIntl(config)`; descending into the callee would read the plugin's own options as
 * the config. Following arguments handles wrappers applied in sequence and a curried one
 * without either being a special case.
 *
 * The carrier is the first argument that is not a function, not simply the first. A project that
 * applies its plugins by folding over a list writes the config as the fold's seed and the plugin
 * application as its first argument — `nextPlugins.reduce((acc, plugin) => plugin(acc), nextConfig)`
 * in `jakejarvis/jarv.is`. Following the first argument there reads the reducer, which resolves to
 * no object literal, and the whole configuration goes unread: eleven options the project sets,
 * `cacheComponents` and `redirects` among them, and five of the twelve documented constraints
 * checked instead of twelve. A function passed to a wrapper is the transformation being applied,
 * never the configuration it is applied to, so skipping it needs no knowledge of which method is
 * doing the folding.
 */
function unwrapWrappers(node: ts.Expression): Resolved<ts.Expression> {
  let current = unwrapTypeSyntax(node);
  for (let depth = 0; depth <= MAX_WRAPPER_DEPTH; depth += 1) {
    if (!ts.isCallExpression(current)) return resolved(current);
    if (current.arguments.length === 0) {
      return unresolved("default export is a call with no arguments");
    }
    const carrier = current.arguments
      .map(unwrapTypeSyntax)
      .find((argument) => asFunction(argument) === undefined);
    // Every argument being a function is a call that applies transformations to something this
    // reader cannot see. Reporting one of them as the config would describe a shape nobody wrote.
    if (carrier === undefined) {
      return unresolved("default export is a call whose arguments are all functions");
    }
    current = carrier;
  }
  return unresolved(`config is wrapped more than ${MAX_WRAPPER_DEPTH} plugins deep`);
}

/**
 * Resolves the config object literal, allowing plugin wrappers and one level of variable
 * indirection. Real configs need both: one project ends in
 * `export default withBundleAnalyzer(nextConfig)`, another in
 * `withBundleAnalyzer({ … })(withNextIntl(nextConfig))`.
 */
export function readNextConfig(
  projectRoot: string,
  resolvePackageDirectory?: PackageDirectoryResolver,
): NextConfigSource | undefined {
  const read = readConfigObject(projectRoot);
  if (read === undefined) return undefined;
  return {
    ...read,
    importedObjects: resolvePackageDirectory
      ? importedObjectKeys(read.source, resolvePackageDirectory)
      : new Map(),
  };
}

/**
 * Whether the file binds this name anywhere of its own — at the top level, inside a function, or by
 * assigning to it. Any of the three means a spread of the name may not be the import, and the whole
 * file is searched rather than one scope because the answer only has to be safe, not precise.
 */
function declaresName(source: ts.SourceFile, name: string): boolean {
  let declared = false;
  const visit = (node: ts.Node): void => {
    if (declared) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      declared = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return declared || assignsTo([...source.statements], name);
}

/** The entry file a package's manifest points at, or the index file a source-only package ships. */
function packageEntryFile(directory: string): string | undefined {
  const manifestPath = join(directory, "package.json");
  const declared: string[] = [];
  if (existsSync(manifestPath)) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest !== null && typeof manifest === "object") {
        for (const field of ["module", "main"] as const) {
          const value = (manifest as Record<string, unknown>)[field];
          if (typeof value === "string") declared.push(value);
        }
      }
    } catch {
      // A manifest that does not parse names no entry, which the index fallback answers anyway.
    }
  }
  const candidates = [
    // A workspace package is often consumed from source, so a `main` pointing into an unbuilt
    // `dist` is tried and then given up on rather than deciding the package has no entry.
    ...declared.flatMap((value) => [
      join(directory, value),
      ...IMPORT_EXTENSIONS.map((extension) =>
        join(directory, value.replace(/\.[cm]?js$/, "") + extension),
      ),
    ]),
    ...IMPORT_EXTENSIONS.map((extension) => join(directory, `index${extension}`)),
  ];
  // A file, not merely something that exists: `main` pointing at an unbuilt `./dist` names a
  // directory, and reading one throws rather than answering that the package states no keys.
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * For each name the config imports from a workspace package, the keys of the object literal that
 * package exports under it.
 *
 * `nakafaai/nakafa.com` writes `const nextConfig = { ...config, … }` with `config` coming from
 * `@repo/next-config`. The spread made every option the app does not write unaffirmable, and seven
 * of the twelve documented constraints went uncounted with it. Only the keys are read: what the
 * shared base *sets* stays unread, and reporting it as this project's configuration would attribute
 * a package's values to an app that merely spreads it.
 */
function importedObjectKeys(
  source: ts.SourceFile,
  resolvePackageDirectory: PackageDirectoryResolver,
): ReadonlyMap<string, readonly string[]> {
  const keysByLocalName = new Map<string, readonly string[]>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || specifier.text.startsWith(".")) continue;
    const clause = statement.importClause;
    // A type-only import brings no value into the file, so nothing it names can be spread.
    if (clause === undefined || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;

    const directory = resolvePackageDirectory(specifier.text);
    if (directory === undefined) continue;
    const entry = packageEntryFile(directory);
    if (entry === undefined) continue;

    let exported: ts.SourceFile;
    try {
      exported = ts.createSourceFile(
        entry,
        readFileSync(entry, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
    } catch {
      // A file that cannot be read states no keys, which is the answer a spread of it already had.
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      // A name the config file also declares somewhere is not reliably the imported one at the
      // point it is spread, and attributing a package's keys to a local object would state a
      // configuration surface this project does not have.
      if (declaresName(source, element.name.text)) continue;
      const exportedName = element.propertyName?.text ?? element.name.text;
      const declared = valueDeclaredAs([...exported.statements], exportedName);
      if (declared === undefined) continue;
      const keys = spreadKeys(declared, new Map());
      if (keys !== undefined) keysByLocalName.set(element.name.text, keys);
    }
  }
  return keysByLocalName;
}

function readConfigObject(
  projectRoot: string,
):
  | { path: string; object: Resolved<ts.ObjectLiteralExpression>; source: ts.SourceFile }
  | undefined {
  const found = CONFIG_FILENAMES.map((name) => join(projectRoot, name)).find((p) => existsSync(p));
  if (!found) return undefined;

  const source = ts.createSourceFile(
    found,
    readFileSync(found, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const defaultExport = findDefaultExport(source);
  if (!defaultExport) {
    return {
      path: found,
      source,
      object: unresolved(
        "next.config has neither a default export nor a module.exports assignment",
      ),
    };
  }

  if (defaultExport.kind === "expression") {
    return { path: found, source, object: objectOf(source, [], defaultExport.expression) };
  }

  // A function is read for what it returns, whether it is written here or named here.
  const scopes = [bodyStatements(defaultExport.fn), [...source.statements]];
  return { path: found, source, object: objectReturnedBy(source, scopes, defaultExport.fn) };
}

/**
 * How many names may be followed before the walk gives up. Named apart from the wrapper bound
 * because they limit different things, and set to the same figure because both exist to stop a
 * hand-rolled config from being walked forever.
 */
const MAX_INDIRECTION_DEPTH = 6;

/**
 * How many conditionals this walk may descend through before it gives up.
 *
 * Its own bound because neither of the other two reaches the case that needs one. Deep syntactic
 * nesting is not it: measured against this reader, a chain of five hundred nested ternaries
 * resolves, and past roughly six hundred the throw comes from inside the TypeScript parser
 * building the AST, before any of this runs. What needs the bound is a cycle between names —
 * `const a = flag ? b : b; const b = flag ? a : a;` is three lines the parser handles without
 * trouble, and walking it descends forever, because each branch is walked by a fresh call that
 * restarts the indirection count guarding the name-following loop. Counting conditionals across
 * those calls is what closes it, and it closes it as an unresolved config with a reason, which is
 * how every other config this reader will not follow is answered.
 */
const MAX_CONDITIONAL_DEPTH = 6;

/**
 * Resolves an expression to the config object literal, peeling wrappers and following names.
 *
 * `scopes` are the statement lists a name may be declared in, innermost first, which is the order
 * the language consults them. A name declared twice, or assigned to after its declaration, is
 * refused rather than resolved: the file settles nothing this reader can follow, and a guess here
 * would report a config nobody wrote.
 *
 * `conditionals` is how many conditionals this walk already descended into, carried across the
 * recursive calls rather than restarted by them.
 */
function objectOf(
  source: ts.SourceFile,
  scopes: readonly (readonly ts.Statement[])[],
  node: ts.Expression,
  conditionals = 0,
  functions = 0,
): Resolved<ts.ObjectLiteralExpression> {
  const lists = [...scopes, [...source.statements]];
  let current = node;

  for (let depth = 0; depth <= MAX_INDIRECTION_DEPTH; depth += 1) {
    const unwrapped = unwrapWrappers(current);
    if (unwrapped.status === "unresolved") return unresolved(unwrapped.reason);
    current = unwrapped.value;

    if (ts.isObjectLiteralExpression(current)) return resolved(current);

    // A conditional is settled the way a function with several returns is: both sides are walked,
    // and the config is the literal they agree on. `dkast/biztro` writes
    // `const nextConfig = enableBundleAnalyzer ? withBundleAnalyzer(baseConfig) : baseConfig`,
    // where a plugin is applied or not depending on the environment — the same configuration
    // either way, since a wrapper is applied to it rather than replacing it. Reading it needs no
    // knowledge of which branch runs, and both sides are already shapes this walk follows, so the
    // condition itself is never evaluated. Where the sides reach different literals the file holds
    // no single answer, and neither is chosen.
    if (ts.isConditionalExpression(current)) {
      if (conditionals >= MAX_CONDITIONAL_DEPTH) {
        return unresolved(`config branches more than ${MAX_CONDITIONAL_DEPTH} conditionals deep`);
      }
      const next = conditionals + 1;
      const whenTrue = objectOf(source, scopes, current.whenTrue, next, functions);
      if (whenTrue.status === "unresolved") return whenTrue;
      const whenFalse = objectOf(source, scopes, current.whenFalse, next, functions);
      if (whenFalse.status === "unresolved") return whenFalse;
      // Node identity, not a structural comparison. The case that occurs is one name resolved
      // twice, once through a wrapper and once bare, which reaches the one literal. Two literals
      // written apart are two configurations the project chose to write apart, and deciding when
      // two of those are the same is a larger claim than this reader has to make.
      return whenTrue.value === whenFalse.value
        ? resolved(whenTrue.value)
        : unresolved("the exported config differs by branch of a conditional");
    }

    if (!ts.isIdentifier(current)) {
      return unresolved("default export is not an object literal");
    }

    const name = current.text;

    // A name bound to a function is followed into it, and the function is read for what it returns
    // exactly as one written in the export position is. `polarsource/polar` writes
    // `const createConfig = async () => { … return conf }` and exports the name — a configuration
    // stated no less plainly than by putting the same function after `export default`. Asked
    // through `functionDeclaredAs` so that both ways of declaring one are followed, and so that a
    // name declared twice or assigned to is refused here for the reason it is refused everywhere.
    // The count is carried across the call rather than restarted by it: two names reaching each
    // other through functions would otherwise descend forever, which is how the conditional walk
    // once overflowed the stack.
    const holder = lists.find((statements) => functionDeclaredAs(statements, name) !== undefined);
    const fn = holder && functionDeclaredAs(holder, name);
    if (fn !== undefined) {
      if (functions >= MAX_FUNCTION_DEPTH) {
        return unresolved(`config is returned more than ${MAX_FUNCTION_DEPTH} functions deep`);
      }
      return objectReturnedBy(source, [bodyStatements(fn), ...scopes], fn, conditionals, functions);
    }

    const list = lists.find((statements) => valueDeclaredAs(statements, name) !== undefined);
    const value = list && valueDeclaredAs(list, name);
    if (value === undefined) {
      return unresolved(`could not resolve '${name}' to an object literal`);
    }
    // The refusal stands wherever an assignment could change what is configured, and steps aside
    // where every one of them only applies a plugin to the name. Asked per scope, and every scope
    // that assigns must answer yes: one that replaces the name leaves the declaration stale however
    // plainly another wraps it. Relaxed at this call site rather than inside the guard, so the four
    // other readings that consult it — rule lists above all, where a stale binding once had this
    // reader report a rule against a route the project serves — cannot inherit it by accident.
    const assigning = lists.filter((statements) => assignsTo(statements, name));
    if (
      assigning.length > 0 &&
      !assigning.every((statements) => onlyWrapsItself(statements, name))
    ) {
      return unresolved(`'${name}' is assigned after it is declared`);
    }
    current = value;
  }
  return unresolved(`config is nested more than ${MAX_INDIRECTION_DEPTH} names deep`);
}

/**
 * How many functions a configuration may be returned through. Bounded like every other walk here,
 * and carried across the recursion rather than restarted by it.
 */
const MAX_FUNCTION_DEPTH = 4;

/**
 * The single object literal every return of a function reaches, or the reason there is not one.
 *
 * Shared by the two places a function holds the configuration: written in the export position, and
 * named there. A function is never run and its parameters are never interpreted — `phase` is an
 * argument this reader does not have.
 */
function objectReturnedBy(
  source: ts.SourceFile,
  scopes: readonly (readonly ts.Statement[])[],
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  conditionals = 0,
  functions = 0,
): Resolved<ts.ObjectLiteralExpression> {
  const returns = returnedExpressions(fn);
  if (returns.length === 0) return unresolved("the exported config function returns nothing");

  let settled: ts.ObjectLiteralExpression | undefined;
  for (const expression of returns) {
    const object = objectOf(source, scopes, expression, conditionals, functions + 1);
    if (object.status === "unresolved") return object;
    // Two returns reaching different objects is a config that differs by branch, and the file
    // holds no single answer. Reporting one would describe a config the project does not always
    // have, so neither is chosen.
    if (settled !== undefined && settled !== object.value) {
      return unresolved("the exported config function returns a different config per branch");
    }
    settled = object.value;
  }
  return settled === undefined
    ? unresolved("the exported config function returns nothing")
    : resolved(settled);
}

function literalOf(node: ts.Expression): Resolved<ConfigLiteral> {
  const expression = unwrapTypeSyntax(node);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return resolved(true);
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return resolved(false);
  if (expression.kind === ts.SyntaxKind.NullKeyword) return resolved(null);
  if (ts.isStringLiteral(expression)) return resolved(expression.text);
  if (ts.isNumericLiteral(expression)) return resolved(Number(expression.text));
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken) {
    const operand = expression.operand;
    if (ts.isNumericLiteral(operand)) return resolved(-Number(operand.text));
  }
  return unresolved("value is computed, not a literal");
}

/**
 * What a lookup found. `"opaque"` and `"maybeSpread"` were one answer until presence needed to
 * tell them apart: a method or shorthand carries the option's name, so the option is there even
 * though its value is not readable, while a spread only means the option might be.
 */
type PropertyLookup = ts.Expression | "opaque" | "maybeSpread" | undefined;

/**
 * How deep a spread's own spreads may be followed. Bounded for the same reason every other walk
 * here is: a hand-rolled configuration should not be walked forever.
 */
const MAX_SPREAD_DEPTH = 4;

/**
 * The keys a spread can contribute, or nothing where that is not knowable.
 *
 * A spread of a name, a call, or anything else this reader cannot see into carries keys nobody
 * wrote in the file, and every option the file does not write stays unaffirmable as a result.
 * A spread of an object literal is different: it can only carry the keys written in it. So is a
 * conditional between two of them — `...(process.env.VERCEL ? {} : { output: 'standalone' })`,
 * which `hugodemenez/deltalytix` writes, and `...(hosts?.length ? { allowedDevOrigins } : {})`,
 * which `saleor/storefront` does. Both sides are literal, so the union of their keys is the whole
 * of what the spread can bring, whichever branch a deploy takes. The condition is not evaluated:
 * knowing the keys does not require knowing which side runs.
 */
/**
 * The value a name is bound to at the top level of the file it is spread in.
 *
 * `arrayHeldBy`'s twin, and deliberately not folded together with it: that one takes the scopes in
 * play because a returned list may be declared inside the function body, while a spread of the
 * configuration object is read against the file's own statements. What the two share they share by
 * calling it — the refusal first, then the binding.
 *
 * A name the file assigns to is refused before it is followed, for the reason `arrayHeldBy` gives:
 * what a name was declared with is not what it holds where it is spread, and keys taken from the
 * replaced binding would report an option absent from a configuration that sets it.
 *
 * The value is returned rather than a literal: whether its keys are knowable is `spreadKeys`'s
 * question, and asking it here in narrower terms is what left `47ng/nuqs` unread after the name was
 * followed. It binds `enableCacheComponents` to a conditional between two literals — a shape
 * `spreadKeys` already reads, reached through a name it now follows.
 */
function valueHeldBy(name: ts.Identifier): ts.Expression | undefined {
  const statements = [...name.getSourceFile().statements];
  if (assignsTo(statements, name.text)) return undefined;
  return valueDeclaredAs(statements, name.text);
}

function spreadKeys(
  node: ts.Expression,
  imported: ReadonlyMap<string, readonly string[]>,
  depth = 0,
): readonly string[] | undefined {
  if (depth > MAX_SPREAD_DEPTH) return undefined;
  const value = unwrapTypeSyntax(node);

  if (ts.isConditionalExpression(value)) {
    const whenTrue = spreadKeys(value.whenTrue, imported, depth + 1);
    const whenFalse = spreadKeys(value.whenFalse, imported, depth + 1);
    if (whenTrue === undefined || whenFalse === undefined) return undefined;
    return [...whenTrue, ...whenFalse];
  }
  // `...(isDev && { … })`, which `simstudioai/sim` writes to add a group of options in development.
  // A false condition spreads a value carrying no keys and a true one spreads the right side
  // entire, so the right side's keys are the whole of what the spread may bring. Only the right
  // side is read: whatever the left holds, the operator discards it when the right side is reached.
  // `||` and `??` are deliberately not here — both can spread their LEFT side, and which one they
  // spread is not knowable without evaluating it.
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return spreadKeys(value.right, imported, depth + 1);
  }
  // A name imported from a workspace package states its keys through that package's own source; a
  // name the file binds itself states them in the literal it is bound to, which is how a project
  // turning a group of options on by environment writes them.
  if (ts.isIdentifier(value)) {
    const fromPackage = imported.get(value.text);
    if (fromPackage !== undefined) return fromPackage;
    const held = valueHeldBy(value);
    return held === undefined ? undefined : spreadKeys(held, imported, depth + 1);
  }
  if (!ts.isObjectLiteralExpression(value)) return undefined;

  const keys: string[] = [];
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      const nested = spreadKeys(property.expression, imported, depth + 1);
      if (nested === undefined) return undefined;
      keys.push(...nested);
      continue;
    }
    const propertyName = property.name;
    // A computed key is a name this reader does not have, so the set stops being the whole of it.
    if (propertyName === undefined) return undefined;
    if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
      keys.push(propertyName.text);
      continue;
    }
    return undefined;
  }
  return keys;
}

function propertyNamed(
  object: ts.ObjectLiteralExpression,
  name: string,
  imported: ReadonlyMap<string, readonly string[]> = new Map(),
): PropertyLookup {
  let hasSpread = false;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      // A spread whose keys are known can only be hiding one of them. Where the option is not
      // among them, the file still states everything there is to state about it.
      const keys = spreadKeys(property.expression, imported);
      if (keys === undefined || keys.includes(name)) hasSpread = true;
      continue;
    }
    if (!property.name) continue;
    const key = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (key !== name) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    // Shorthand or method: the name is written here, the value lives elsewhere.
    return "opaque";
  }
  return hasSpread ? "maybeSpread" : undefined;
}

/**
 * Reads a literal addressed by a dotted path, walking nested object literals.
 * The flags gating `forbidden` and `unauthorized` live at `experimental.authInterrupts`,
 * so single-level resolution would silently miss them.
 */
/**
 * What a completed walk can land on: the expression at the end, `"opaque"` when the property is
 * named with an unreadable value, or nothing when it is not there. A walk that could not finish
 * is unresolved instead, so `"maybeSpread"` never escapes as a value.
 */
type PathEnd = ts.Expression | "opaque" | undefined;

/** The outcome of walking a dotted path: what sits at the end, or why the walk stopped. */
function walkTo(source: NextConfigSource | undefined, path: string): Resolved<PathEnd> | undefined {
  if (!source) return undefined;
  if (source.object.status === "unresolved") return unresolved(source.object.reason);

  const segments = path.split(".");
  let current: ts.ObjectLiteralExpression = source.object.value;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) return unresolved(`malformed flag path '${path}'`);
    const value = propertyNamed(current, segment, source.importedObjects);

    if (value === undefined) return resolved(undefined);
    if (value === "opaque") {
      return index === segments.length - 1
        ? resolved("opaque")
        : unresolved(`'${segment}' is a method or shorthand`);
    }
    if (value === "maybeSpread") return unresolved(`'${segment}' may come from a spread`);
    if (index === segments.length - 1) return resolved(value);

    const nested = unwrapTypeSyntax(value);
    if (!ts.isObjectLiteralExpression(nested)) {
      return unresolved(`'${segment}' is not an object literal`);
    }
    current = nested;
  }
  return resolved(undefined);
}

export function readFlag(
  source: NextConfigSource | undefined,
  path: string,
): Resolved<ConfigLiteral | undefined> {
  const found = walkTo(source, path);
  if (found === undefined) return resolved(undefined);
  if (found.status === "unresolved") return unresolved(found.reason);
  if (found.value === undefined) return resolved(undefined);
  if (found.value === "opaque") return unresolved(`'${path}' is a method or shorthand`);
  return literalOf(found.value);
}

/**
 * Whether a configuration path is written at all, regardless of what its value is.
 *
 * `readFlag` answers with the value, so an option holding an array or an object comes back
 * unresolved — the same answer as an option nobody wrote. A predicate asking about
 * `serverExternalPackages` needs the other question: is it configured.
 *
 * Absent is reported only when the walk succeeded and the property was not there. A walk that
 * could not be completed is unresolved, because an option nobody could look for is not an
 * option that is missing, and treating it as missing is how a tool suggests adopting what a
 * project already has.
 */
export function readFlagPresence(
  source: NextConfigSource | undefined,
  path: string,
): Resolved<boolean> {
  const found = walkTo(source, path);
  if (found === undefined) return resolved(false);
  if (found.status === "unresolved") return unresolved(found.reason);
  // Named here with an unreadable value still means the option is written.
  return resolved(found.value !== undefined);
}

/**
 * The literals of an array option, with what could not be read counted rather than hidden.
 *
 * `branched` says the values were gathered from both sides of a conditional, so the list holds
 * what the option writes under either branch rather than under the one that runs. Most readings
 * of a list ask whether a name is written, and a name written in either branch is written; the
 * one that decides which files are route conventions cannot answer from that, and declines. The
 * marker is on the value so a reading that must decline says so itself, rather than every reading
 * inheriting one answer.
 */
export type ConfigList = {
  readonly values: readonly string[];
  readonly skipped: number;
  readonly branched: boolean;
};

/**
 * Resolves the string literals an array option holds.
 *
 * A partial list is reported as partial: an element that is not a literal is counted rather than
 * dropped, so a name excluded from the reading is never mistaken for a name that is not there.
 */
/**
 * The top-level keys an option's object literal writes down, for an option whose keys are the
 * thing being configured rather than a value to compare against.
 *
 * Names only. What each key is set to is a value the project chose and this reader has no use for;
 * that a key is there at all is what `env` and its like are read for.
 */
export function readFlagKeys(
  source: NextConfigSource | undefined,
  path: string,
): Resolved<readonly string[]> {
  const found = walkTo(source, path);
  if (found === undefined) return resolved([]);
  if (found.status === "unresolved") return unresolved(found.reason);
  if (found.value === undefined) return resolved([]);
  if (found.value === "opaque") return unresolved(`'${path}' is a method or shorthand`);

  const object = unwrapTypeSyntax(found.value);
  if (!ts.isObjectLiteralExpression(object)) {
    return unresolved(`'${path}' is not an object literal`);
  }
  // A spread may carry keys nobody wrote here, so the set is no longer what the file states.
  if (object.properties.some((property) => ts.isSpreadAssignment(property))) {
    return unresolved(`'${path}' may carry keys from a spread`);
  }

  const keys: string[] = [];
  for (const property of object.properties) {
    const { name } = property;
    if (name === undefined) continue;
    if (ts.isIdentifier(name)) keys.push(name.text);
    else if (ts.isStringLiteral(name)) keys.push(name.text);
  }
  return resolved(keys);
}

export function readFlagList(
  source: NextConfigSource | undefined,
  path: string,
): Resolved<ConfigList> {
  const found = walkTo(source, path);
  if (found === undefined) return resolved({ values: [], skipped: 0, branched: false });
  if (found.status === "unresolved") return unresolved(found.reason);
  // Nothing is in a list nobody wrote; a list we cannot read is not the same thing.
  if (found.value === undefined) return resolved({ values: [], skipped: 0, branched: false });
  if (found.value === "opaque") return unresolved(`'${path}' is a method or shorthand`);

  const arrays = arrayBranches(unwrapTypeSyntax(found.value));
  if (arrays === undefined) return unresolved(`'${path}' is not an array literal`);

  const values: string[] = [];
  let skipped = 0;
  for (const array of arrays.arrays) {
    for (const element of array.elements) {
      const literal = literalOf(element);
      if (literal.status === "unresolved" || typeof literal.value !== "string") skipped += 1;
      else values.push(literal.value);
    }
  }
  return resolved({ values, skipped, branched: arrays.branched });
}

/**
 * The array literals a value holds, following a conditional into both of its branches.
 *
 * An option turned on by the environment is written as `cond ? [something] : []`, which is the
 * shape `voidcraft-labs/commcare-nova` gives `instrumentationClientInject`. Both branches are
 * walked and neither is chosen: the condition is never evaluated, exactly as `objectOf` never
 * evaluates the one it walks. The two readers differ in what they do with the branches because
 * they answer different questions — `objectOf` must name one configuration, so it refuses two
 * literals written apart; a list is asked which names are written, and a name in either branch is
 * written.
 *
 * Either branch failing to be an array literal fails the whole reading. Taking the readable branch
 * alone would report a list as complete while the other branch's names went uncounted, and
 * `skipped` cannot stand in for them: a branch that is not a literal has no known element count.
 *
 * The walk descends the syntax of the conditional and never follows a name, so it cannot cycle;
 * deep syntactic nesting is bounded by the parser, which builds the tree before any of this runs.
 */
function arrayBranches(
  node: ts.Expression,
): { arrays: readonly ts.ArrayLiteralExpression[]; branched: boolean } | undefined {
  if (ts.isArrayLiteralExpression(node)) return { arrays: [node], branched: false };
  if (!ts.isConditionalExpression(node)) return undefined;

  const whenTrue = arrayBranches(unwrapTypeSyntax(node.whenTrue));
  if (whenTrue === undefined) return undefined;
  const whenFalse = arrayBranches(unwrapTypeSyntax(node.whenFalse));
  if (whenFalse === undefined) return undefined;
  return { arrays: [...whenTrue.arrays, ...whenFalse.arrays], branched: true };
}

/**
 * The function a name holds at the top level of a file, in either form the language declares one:
 * a function declaration, or a variable initialised with a function.
 *
 * A name declared more than once is refused, and so is one the file assigns to afterwards, for the
 * reason `valueDeclaredAs` refuses the same: two declarations settle nothing this reader can
 * follow, and picking one would read a function the project may not be calling.
 */
function functionDeclaredAs(
  statements: readonly ts.Statement[],
  name: string,
): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined {
  let found: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  for (const statement of statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== name) continue;
    if (found !== undefined) return undefined;
    found = statement;
  }

  const declared = valueDeclaredAs(statements, name);
  const asValue = declared === undefined ? undefined : asFunction(declared);
  if (asValue !== undefined) {
    // A name holding both a declaration and a variable is the same ambiguity, spelled across two
    // kinds of statement rather than two of one.
    if (found !== undefined) return undefined;
    found = asValue;
  }

  return found !== undefined && assignsTo(statements, name) ? undefined : found;
}

/** The function a routing option is written as, whichever of the four shapes it takes. */
function functionBodyOf(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ConciseBody | undefined {
  for (const property of object.properties) {
    if (!property.name) continue;
    const key = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (key !== name) continue;
    if (ts.isMethodDeclaration(property)) return property.body;
    if (!ts.isPropertyAssignment(property)) return undefined;
    const initialiser = unwrapTypeSyntax(property.initializer);
    if (ts.isArrowFunction(initialiser) || ts.isFunctionExpression(initialiser)) {
      return initialiser.body;
    }
    // The option may name a function the file declares elsewhere rather than write one in place.
    // `nakafaai/nakafa.com` writes `rewrites: createAppRewrites` above a `function
    // createAppRewrites()` in the same file, which is the documented signature moved rather than
    // changed — the framework calls exactly what it would have called inline. Not reading it cost
    // both interception checks, and the configuration is otherwise read in full.
    if (ts.isIdentifier(initialiser)) {
      return functionDeclaredAs(object.getSourceFile().statements, initialiser.text)?.body;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Strips the wrappers an async function puts around a value it is returning anyway: `await`, and
 * a `Promise.resolve` around the payload. Neither changes what the array holds, and the primary
 * fixture writes `return await Promise.resolve([...])` — a shape that read as an absent option
 * until this existed.
 */
function unwrapReturnedValue(node: ts.Expression): ts.Expression {
  let current = unwrapTypeSyntax(node);
  for (;;) {
    if (ts.isAwaitExpression(current)) {
      current = unwrapTypeSyntax(current.expression);
      continue;
    }
    const isPromiseResolve =
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === "Promise" &&
      current.expression.name.text === "resolve" &&
      current.arguments.length === 1;
    if (isPromiseResolve && ts.isCallExpression(current)) {
      const [only] = current.arguments;
      if (only === undefined) return current;
      current = unwrapTypeSyntax(only);
      continue;
    }
    return current;
  }
}

/** The extensions a relative import may resolve to, in the order a bundler tries them. */
const IMPORT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;

/**
 * The file a relative specifier names, trying each extension and then an index file.
 *
 * Never a file outside the directory the config sits in. A specifier climbing out of it —
 * `'../../../elsewhere/rules'` — names something this project does not hold, and this tool reads
 * repositories it did not write: a list of strings from outside the analysed project would end up
 * printed in its report. A monorepo keeping its rules in a sibling package is left unread for the
 * same reason, which is the safe side of the same line.
 */
function moduleFileFor(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const root = dirname(fromFile);
  const base = join(root, specifier.replace(/\.js$/, ""));
  const candidates = [
    ...IMPORT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...IMPORT_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => {
    const inside = relative(root, candidate);
    if (inside.startsWith("..") || isAbsolute(inside)) return false;
    return existsSync(candidate);
  });
}

/**
 * The array literal a name holds, where the name is imported from a file of the project itself.
 *
 * A rule list long enough to be worth keeping out of the way is kept in its own module and imported
 * back — `jpedroschmitz/typescript-nextjs-starter` writes `import { redirects } from './redirects'`
 * and returns the name. Reading only the config file left that option stating nothing, which is the
 * same answer as an option a project does not write at all.
 *
 * Exactly one hop, and only a named import bound to an exported `const`. A name re-exported from
 * somewhere else, or bound by anything but a literal array, is left unread: each further hop is a
 * file this reader would be following on a guess about what the bundler resolves.
 */
function arrayImportedAs(
  sourceFile: ts.SourceFile,
  name: string,
): ts.ArrayLiteralExpression | undefined {
  const specifier = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .filter((declaration) => {
      const bindings = declaration.importClause?.namedBindings;
      return (
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((element) => element.name.text === name)
      );
    })
    .map((declaration) => declaration.moduleSpecifier)
    .find(ts.isStringLiteral);
  if (!specifier) return undefined;

  const file = moduleFileFor(sourceFile.fileName, specifier.text);
  if (!file) return undefined;

  const imported = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const exported = imported.statements
    .filter(ts.isVariableStatement)
    .filter((statement) =>
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name);
  // Two exports of one name is a file that settles nothing, the same refusal `valueDeclaredAs`
  // makes for a name declared twice.
  if (exported.length !== 1) return undefined;
  const [only] = exported;
  if (!only?.initializer) return undefined;
  const value = unwrapTypeSyntax(only.initializer);
  return ts.isArrayLiteralExpression(value) ? value : undefined;
}

/**
 * The keys the phased form of `rewrites` puts its lists under. Documented on that option's page and
 * on no other: `redirects` and `headers` take a list and nothing else, so a project returning an
 * object from one of those is returning something the framework does not read either.
 */
const REWRITE_PHASES = ["beforeFiles", "afterFiles", "fallback"] as const;

/**
 * The routing options whose page documents the phased form. One today, and named as a set rather
 * than compared inline so that adding a second is a change to this list: whether an option takes an
 * object is a fact about its documentation, not about the shape a project happens to return.
 */
const PHASED_OPTIONS: ReadonlySet<string> = new Set(["rewrites"]);

/**
 * How deep a list may spread other lists before the walk gives up. Bounded like every other walk
 * here, and generously: the spreads observed are one level, of names bound beside the option.
 */
const MAX_SPREAD_LIST_DEPTH = 4;

/**
 * The array literal an expression holds, following a name to the binding it was declared with in
 * the given scopes or imported into the file under.
 *
 * Split out of the returned-value walk because a list assembled from other lists asks the same
 * question of its parts: `[...agentDiscoveryRewrites, ...ogRouteRewrites]` names two arrays the
 * file writes out, and the answer for a spread element is the answer for a returned name.
 */
function arrayHeldBy(
  expression: ts.Expression,
  scopes: readonly (readonly ts.Statement[])[],
): ts.ArrayLiteralExpression | undefined {
  const value = unwrapTypeSyntax(expression);
  if (ts.isArrayLiteralExpression(value)) return value;
  if (!ts.isIdentifier(value)) return undefined;

  // A name any scope in play assigns to is refused before it is followed. What it was declared with
  // is not what it holds when the framework reads it, and these rules are compared against files
  // the project really serves: a list taken from the replaced binding is a rule nobody wrote,
  // reported against a real route. The check spans every scope rather than the declaring one,
  // because a body may reassign a name the file declared.
  if (scopes.some((statements) => assignsTo(statements, value.text))) return undefined;

  for (const statements of scopes) {
    const declared = valueDeclaredAs(statements, value.text);
    // A name declared and not bound to a literal list is a list this reader cannot read, and the
    // search stops there rather than continuing past the binding the language would use.
    if (declared !== undefined) {
      return ts.isArrayLiteralExpression(declared) ? declared : undefined;
    }
  }
  return arrayImportedAs(value.getSourceFile(), value.text);
}

/**
 * The rule elements a list holds, with the lists it spreads into itself expanded in place.
 *
 * A spread of a name the file binds to a literal list contributes exactly that list's rules, which
 * is knowable without running anything. `nakafaai/nakafa.com` assembles its rewrites that way, out
 * of four named lists. A spread of anything else — a call, a name bound to something computed — is
 * left as it is, so the caller counts it unread rather than reporting a partial list as whole.
 */
function spreadElements(
  array: ts.ArrayLiteralExpression,
  scopes: readonly (readonly ts.Statement[])[],
  depth = 0,
): readonly ts.Expression[] {
  return array.elements.flatMap((element) => {
    if (!ts.isSpreadElement(element)) return [element];
    if (depth >= MAX_SPREAD_LIST_DEPTH) return [element];
    const held = arrayHeldBy(element.expression, scopes);
    return held === undefined ? [element] : spreadElements(held, scopes, depth + 1);
  });
}

/**
 * What a function body returns: the arrays, and whether anything was returned that this could not
 * read. Returns from functions nested inside the body are not counted — a helper declared there
 * returns its own rules, and attributing them to the option would read a list it does not hold.
 *
 * `phased` says whether the option documents the object form as well as the list. Under it, an
 * object returning lists under the documented phase keys is read as those lists: the phases decide
 * when each list is applied, not what it holds, and every rule in them is a rule the option
 * declares.
 */
function returnedArrays(
  body: ts.ConciseBody,
  phased: boolean,
): {
  arrays: ts.ArrayLiteralExpression[];
  opaqueReturns: number;
  scopes: readonly (readonly ts.Statement[])[];
} {
  const arrays: ts.ArrayLiteralExpression[] = [];
  let opaqueReturns = 0;
  // The names the option's own body declares. A name bound here shadows a module-level one, so it
  // is consulted first: `async headers() { const headers = await load(); return headers; }` beside
  // a module-level `const headers = [...]` returns the local value, and reading the module's array
  // would report rules the option never held.
  const localStatements = ts.isBlock(body) ? [...body.statements] : [];
  const scopes: readonly (readonly ts.Statement[])[] = [
    localStatements,
    body.getSourceFile().statements,
  ];
  const take = (expression: ts.Expression): void => {
    const value = unwrapReturnedValue(expression);
    if (ts.isArrayLiteralExpression(value)) {
      arrays.push(value);
      return;
    }
    // A rule list a project turns on by environment is written as a conditional returning the
    // rules on one side and an empty list on the other — `darkroomengineering/satus` gates its
    // Storybook proxy that way. Both sides are the option's own value, so both are read; reading
    // neither made a file that states its rules literally report as stating nothing.
    if (ts.isConditionalExpression(value)) {
      take(value.whenTrue);
      take(value.whenFalse);
      return;
    }
    // The phased form, which `rewrites` documents beside the plain list. `mdugue/manuel-dugue`
    // returns `{ beforeFiles: [ … ] }` with every rule written out, and it read as a value this
    // could not take a list from — a fully literal configuration reported as unreadable. Each
    // documented phase is taken as its own list; a key the page does not document is not one, and
    // an object carrying none of them is opaque, as it was before.
    if (phased && ts.isObjectLiteralExpression(value)) {
      let found = false;
      for (const phase of REWRITE_PHASES) {
        const held = propertyNamed(value, phase);
        if (held === undefined) continue;
        // A phase carrying the key counts as the phased form whether or not its value can be read.
        // Counting it only when readable would let an object whose one phase is opaque fall through
        // to be read as some other shape.
        found = true;
        // A phase written as a method, or one a spread may be hiding, is a list this reader cannot
        // take rules from. It is counted here rather than skipped: a sibling phase that does read
        // would otherwise return from this branch and the unread rules would leave no trace, which
        // reports an option read in part as an option read in full.
        if (held === "opaque" || held === "maybeSpread") {
          opaqueReturns += 1;
          continue;
        }
        take(held);
      }
      if (found) return;
    }
    // A name is followed to the array it holds, in this file or in one it imports the name from.
    if (ts.isIdentifier(value)) {
      const held = arrayHeldBy(value, scopes);
      if (held !== undefined) {
        arrays.push(held);
        return;
      }
    }
    opaqueReturns += 1;
  };
  // A concise arrow body is the returned expression itself.
  if (!ts.isBlock(body)) {
    take(body);
    return { arrays, opaqueReturns, scopes };
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) take(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return { arrays, opaqueReturns, scopes };
}

/**
 * The `source` patterns a routing option declares — `redirects`, `rewrites` or `headers`. These
 * are written as async functions rather than as values, so `readFlagList` cannot reach them: it
 * stops at a method, correctly, because a method's value is not in the object.
 *
 * Partial is reported as partial, the same contract the array reader follows. A rule built by a
 * spread or a helper call is counted, never dropped, so a pattern excluded from the reading is
 * not mistaken for one the option does not declare.
 */
export function readRuleSources(
  source: NextConfigSource | undefined,
  option: string,
): Resolved<ConfigList> {
  if (!source) return resolved({ values: [], skipped: 0, branched: false });
  // The configuration as a whole did not resolve, so this says nothing about how the option was
  // written. Naming the option anyway is what keeps the answer attributable: a caller asking about
  // two options gets the same underlying reason twice, and without the name the two are one
  // sentence repeated, which reads as a stutter rather than as two checks that could not run.
  if (source.object.status === "unresolved") {
    return unresolved(`'${option}' could not be read: ${source.object.reason}`);
  }

  const body = functionBodyOf(source.object.value, option);
  // Three answers, not two. Not written at all is an empty list. Written in a shape this does not
  // read has to be unresolved, or an unread rule reads as an absent one. Between them sits the
  // option nobody wrote that a spread could still be carrying: saying of it that it is written in
  // an unreadable shape describes writing the file does not contain, which is a worse thing for
  // this reader to say than that it could not tell. The imported objects are passed so this asks
  // the same question of a spread that every other reading of the configuration asks.
  if (body === undefined) {
    const found = propertyNamed(source.object.value, option, source.importedObjects);
    if (found === undefined) return resolved({ values: [], skipped: 0, branched: false });
    return found === "maybeSpread"
      ? unresolved(`'${option}' may come from a spread`)
      : unresolved(`'${option}' is not written as a function this can read`);
  }

  const { arrays, opaqueReturns, scopes } = returnedArrays(body, PHASED_OPTIONS.has(option));
  // A body returning something this cannot read is not a body returning nothing. Reporting the
  // second would let an unread rule read as a rule the option does not declare.
  if (arrays.length === 0) {
    return unresolved(`'${option}' returns a value this cannot read as a list of rules`);
  }

  const values: string[] = [];
  let skipped = opaqueReturns;
  for (const array of arrays) {
    for (const element of spreadElements(array, scopes)) {
      const rule = unwrapTypeSyntax(element);
      if (!ts.isObjectLiteralExpression(rule)) {
        skipped += 1;
        continue;
      }
      const pattern = propertyNamed(rule, "source");
      if (pattern === undefined || pattern === "opaque" || pattern === "maybeSpread") {
        skipped += 1;
        continue;
      }
      const literal = literalOf(pattern);
      if (literal.status === "unresolved" || typeof literal.value !== "string") skipped += 1;
      else values.push(literal.value);
    }
  }
  return resolved({ values, skipped, branched: false });
}

/** Reads `pageExtensions`, falling back to the documented default when absent. */
export function readPageExtensions(
  source: NextConfigSource | undefined,
): Resolved<readonly string[]> {
  if (!source) return resolved(DEFAULT_PAGE_EXTENSIONS);
  const list = readFlagList(source, "pageExtensions");
  if (list.status === "unresolved") return unresolved(list.reason);
  // All or nothing here, unlike the general reader: a half-read extension list would make the
  // route walk miss files, which is worse than admitting the list could not be read.
  if (list.value.skipped > 0) return unresolved("pageExtensions contains a computed entry");
  // And the same refusal for the other direction, which is the worse one. Every other reading of
  // a list asks whether a name is written, and a name written in either branch is written; this
  // one decides which files count as route conventions, so the union of two branches would have
  // the walk claim conventions in files the running branch does not serve. Unresolved says route
  // discovery may be incomplete, which is the weaker claim and the true one.
  if (list.value.branched) return unresolved("pageExtensions differs by branch of a conditional");
  return list.value.values.length === 0
    ? resolved(DEFAULT_PAGE_EXTENSIONS)
    : resolved(list.value.values);
}
