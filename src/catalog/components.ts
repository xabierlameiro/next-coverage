import type { JsxElementRecord } from "../collect/jsx.js";
import { attributeLiteral, hasAttribute, isInternalPath, suppressesAt } from "../collect/jsx.js";
import type { SourceFileRecord } from "../collect/sources.js";
import { filesImporting, filesImportingModule, productionFiles } from "../collect/sources.js";
import type { PredicateContext, PredicateSet, Suggestion, Verdict } from "./types.js";
import { match, NO_MATCH, suggest } from "./types.js";

/** The media type that makes a script element structured data rather than a third-party script. */
const JSON_LD = "application/ld+json";

const FONT_MODULES = ["next/font/google", "next/font/local"] as const;

const COMPONENT_MODULES: Readonly<Record<string, string>> = {
  "components/image": "next/image",
  "components/link": "next/link",
  "components/script": "next/script",
  "components/form": "next/form",
};

/** Every element of a tag rendered outside test files, paired with the file that renders it. */
function productionElements(
  context: PredicateContext,
  tag: string,
): { file: SourceFileRecord; element: JsxElementRecord }[] {
  return productionFiles(context.sources).flatMap((file) =>
    file.jsxElements.filter((element) => element.tag === tag).map((element) => ({ file, element })),
  );
}

function filesOf(hits: readonly { file: SourceFileRecord }[]): string[] {
  return [...new Set(hits.map((hit) => hit.file.path))];
}

function suggestion(paths: readonly string[], note: string, gain: string): Suggestion {
  return paths.length === 0 ? NO_MATCH : suggest(paths, note, gain);
}

function detectComponent(module: string) {
  return (context: PredicateContext): Verdict => {
    const files = filesImporting(context.sources, module, "default");
    return files.length === 0 ? NO_MATCH : match(files.map((file) => file.path));
  };
}

/**
 * The image entry carries several conditions. They are checked in order of how much they
 * change, and the first match is reported, so the note always describes one thing.
 */
/** The rule an ESLint configuration turns off to say a raw `img` here is intended. */
const NO_IMG_ELEMENT = "@next/next/no-img-element";

function imageWouldApply(context: PredicateContext): Suggestion {
  // An element the project's own lint configuration exempts is a decision somebody already made,
  // and arguing against it is arguing with the author rather than telling them anything. A raw
  // `img` behind a disable for this exact rule is therefore dropped before the file is named — but
  // only for this rule: a disable naming a different one, or naming none at all, says nothing about
  // this question and leaves the element reportable.
  const rawImages = filesOf(
    productionElements(context, "img").filter(
      ({ file, element }) => !suppressesAt(file.lintSuppressions, NO_IMG_ELEMENT, element.line),
    ),
  );
  if (rawImages.length > 0) {
    return suggestion(
      rawImages,
      "these render a raw img element, so nothing resizes or lazy-loads it",
      "Image serves each one resized to the viewport in a modern format, lazy-loads it below the fold and reserves its box so the layout does not shift",
    );
  }

  const fillWithoutSizes = productionElements(context, "Image").filter(
    ({ element }) => hasAttribute(element, "fill") && !hasAttribute(element, "sizes"),
  );
  if (fillWithoutSizes.length > 0) {
    return suggestion(
      filesOf(fillWithoutSizes),
      "fill without sizes makes the browser assume the full viewport and fetch the largest variant",
      "with sizes set, the browser picks the variant that matches the slot it fills",
    );
  }

  const deprecatedPriority = productionElements(context, "Image").filter(({ element }) =>
    hasAttribute(element, "priority"),
  );
  return suggestion(
    filesOf(deprecatedPriority),
    "priority is deprecated in this version in favour of preload",
    "preload is the property this version reads, so the hint reaches the browser",
  );
}

function linkWouldApply(context: PredicateContext): Suggestion {
  const internal = productionElements(context, "a").filter(({ element }) => {
    const href = attributeLiteral(element, "href");
    // A computed href is unknown, and guessing here is what produces noise.
    return href !== undefined && isInternalPath(href);
  });
  return suggestion(
    filesOf(internal),
    "these navigate internally with a raw anchor, so there is no client navigation or prefetch",
    "Link prefetches the route once it is in the viewport and navigates on the client, keeping the layouts already rendered",
  );
}

function scriptWouldApply(context: PredicateContext): Suggestion {
  const thirdParty = productionElements(context, "script").filter(({ element }) => {
    // Structured data is the pattern the framework's own docs prescribe, not an opportunity.
    if (attributeLiteral(element, "type") === JSON_LD) return false;
    const src = attributeLiteral(element, "src");
    return src !== undefined && !isInternalPath(src);
  });
  return suggestion(
    filesOf(thirdParty),
    "these load a third-party script that blocks hydration instead of being scheduled",
    "Script loads it after hydration, or lazily, so the page is interactive before the script runs",
  );
}

/**
 * Raw forms that navigate to a path with their fields as search parameters — the one thing the
 * form component is documented for. It extends the HTML element with prefetching, client-side
 * navigation and progressive enhancement, all of which are about a navigation.
 *
 * A form whose action is an identifier or a function is posting to a server function, which is
 * doing something else entirely; a form whose action is an expression is going somewhere unknown,
 * and guessing there is what produces noise. The method is read the same way: absent or a literal
 * `get` is a navigation, a literal `post` is not, and a method written as an expression leaves the
 * question open, so the form is left alone.
 *
 * An `onSubmit` handler leaves it alone too. The handler is where a form cancels the navigation and
 * submits by hand, and whether this one does needs the handler's body; the message here states that
 * the form navigates, so a form that may not is a form this condition has nothing to say about.
 */
function formWouldApply(context: PredicateContext): Suggestion {
  const navigating = productionElements(context, "form").filter(({ element }) => {
    if (hasAttribute(element, "onSubmit")) return false;
    const action = attributeLiteral(element, "action");
    if (action === undefined || !isInternalPath(action)) return false;
    const method = attributeLiteral(element, "method");
    if (method !== undefined) return method.toLowerCase() === "get";
    return !hasAttribute(element, "method");
  });
  return suggestion(
    filesOf(navigating),
    "these raw forms navigate to a path they name, with their fields as search parameters",
    "Form prefetches that route as the form comes into view and submits on the client, so the results render without a full page load and still work before hydration",
  );
}

function fontWouldApply(context: PredicateContext): Suggestion {
  const remote = productionElements(context, "link").filter(({ element }) => {
    const href = attributeLiteral(element, "href");
    return href?.includes("fonts.googleapis.com") === true;
  });
  return suggestion(
    filesOf(remote),
    "these fetch a font stylesheet at runtime instead of self-hosting it",
    "next/font downloads the font at build time and serves it from the same origin, with no request to Google at runtime and no layout shift from a late swap",
  );
}

const WOULD_APPLY: Readonly<Record<string, (context: PredicateContext) => Suggestion>> = {
  "components/image": imageWouldApply,
  "components/link": linkWouldApply,
  "components/script": scriptWouldApply,
  "components/font": fontWouldApply,
  "components/form": formWouldApply,
};

export const COMPONENT_PREDICATES: readonly PredicateSet[] = [
  ...Object.entries(COMPONENT_MODULES).map(([id, module]): PredicateSet => {
    const wouldApply = WOULD_APPLY[id];
    const detectUsed = detectComponent(module);
    if (wouldApply === undefined) throw new Error(`no condition authored for '${id}'`);
    return { id, cost: "AST", detectUsed, wouldApply };
  }),
  {
    // One page documents both loaders, so either import counts as the font entry being used.
    id: "components/font",
    cost: "AST",
    detectUsed: (context) => {
      const files = FONT_MODULES.flatMap((module) => filesImportingModule(context.sources, module));
      return files.length === 0 ? NO_MATCH : match([...new Set(files.map((f) => f.path))]);
    },
    wouldApply: fontWouldApply,
  },
];
