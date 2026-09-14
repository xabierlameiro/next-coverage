import ts from "typescript";
import type { JsxElementRecord } from "./jsx.js";

/**
 * What the documentation gives as reasons to declare the client directive, read one file at a time.
 * A file showing none of them exhibits nothing the directive exists for.
 *
 * Read from the syntax tree rather than the source text: `onClick` inside a string, a `window` in a
 * comment and a `useState` in an import specifier all read as a reason to a regular expression, and
 * a reason found where there is none is a file the report never mentions.
 */
export type ClientDirectiveReasons = {
  /** A call to an identifier beginning with `use` and an upper-case letter. */
  readonly hookCall: boolean;
  /** A JSX attribute beginning with `on` and an upper-case letter. */
  readonly handlerAttribute: boolean;
  /** A reference to a global only a browser has. */
  readonly browserGlobal: boolean;
  /** An import of `client-only`, the package whose whole purpose is to fail on the server. */
  readonly clientOnlyImport: boolean;
  /** A class extending the framework's component class, which has no server equivalent. */
  readonly classComponent: boolean;
  /** A call to `createContext`, which needs a client boundary to be provided from. */
  readonly createsContext: boolean;
};

const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
]);

const FRAMEWORK_COMPONENT_CLASSES = new Set(["Component", "PureComponent"]);

const CLIENT_ONLY_SPECIFIER = "client-only";

/** Whether any of the documented reasons was found. */
export function showsNoReason(reasons: ClientDirectiveReasons): boolean {
  return (
    !reasons.hookCall &&
    !reasons.handlerAttribute &&
    !reasons.browserGlobal &&
    !reasons.clientOnlyImport &&
    !reasons.classComponent &&
    !reasons.createsContext
  );
}

/**
 * The six facts, for one file. The JSX elements and the specifiers are passed in because the scan
 * already reads both; only the four that need the tree are walked here.
 */
export function clientDirectiveReasons(
  source: ts.SourceFile,
  jsxElements: readonly JsxElementRecord[],
  specifiers: Iterable<string>,
): ClientDirectiveReasons {
  const walked = walk(source);
  return {
    hookCall: walked.hookCall,
    handlerAttribute: jsxElements.some((element) =>
      [...element.attributes.keys()].some(isHandlerName),
    ),
    browserGlobal: walked.browserGlobal,
    clientOnlyImport: [...specifiers].includes(CLIENT_ONLY_SPECIFIER),
    classComponent: walked.classComponent,
    createsContext: walked.createsContext,
  };
}

function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

function isHandlerName(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

/** The callee's name, for the two ways a hook is called: bare, or off the React namespace. */
function calleeName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.name)) {
    return call.expression.name.text;
  }
  return undefined;
}

function extendsComponentClass(node: ts.ClassLikeDeclaration): boolean {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      const { expression } = type;
      if (ts.isIdentifier(expression) && FRAMEWORK_COMPONENT_CLASSES.has(expression.text)) {
        return true;
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        FRAMEWORK_COMPONENT_CLASSES.has(expression.name.text)
      ) {
        return true;
      }
    }
  }
  return false;
}

type Walked = {
  hookCall: boolean;
  browserGlobal: boolean;
  classComponent: boolean;
  createsContext: boolean;
};

/**
 * One pass for the four facts that need the tree. The walk descends by hand where a name is not a
 * reference — the property in `theme.location`, the key in `{ window: 1 }`, the binding in
 * `const document = …` — so a name that happens to match is not read as a use of the global.
 */
function walk(source: ts.SourceFile): Walked {
  const found: Walked = {
    hookCall: false,
    browserGlobal: false,
    classComponent: false,
    createsContext: false,
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      if (callee !== undefined && isHookName(callee)) found.hookCall = true;
      if (callee === "createContext") found.createsContext = true;
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (extendsComponentClass(node)) found.classComponent = true;
    } else if (ts.isPropertyAccessExpression(node)) {
      // The object is a reference; the property after the dot is a name on it.
      visit(node.expression);
      return;
    } else if (ts.isPropertyAssignment(node)) {
      visit(node.initializer);
      return;
    } else if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      // The binding name declares a global's name rather than reading the global.
      if (node.initializer) visit(node.initializer);
      return;
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // A specifier names what another module exports, whatever the name resembles.
      return;
    } else if (ts.isIdentifier(node) && BROWSER_GLOBALS.has(node.text)) {
      found.browserGlobal = true;
      return;
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}
