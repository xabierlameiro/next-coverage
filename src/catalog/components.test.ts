import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileIn, fixtureContext } from "../../test-support/corpus.js";
import type { SurfaceEntry } from "../collect/docs.js";
import { buildGraph } from "../collect/graph.js";
import { EMPTY_JOIN } from "../collect/output.js";
import type { Bundler, ProjectContext } from "../collect/project.js";
import { buildRouteTree } from "../collect/routes.js";
import { scanSources } from "../collect/sources.js";
import { DEFAULT_PAGE_EXTENSIONS, resolved, unresolved } from "../types.js";
import { COMPONENT_PREDICATES } from "./components.js";
import type { PredicateContext } from "./types.js";

function project(files: Record<string, string>): PredicateContext {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-comp-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const appDirectory = { path: join(root, "app") };
  mkdirSync(appDirectory.path, { recursive: true });
  const context: ProjectContext = {
    root,
    appDirectory,
    installedNext: undefined,
    version: resolved("16.3.0"),
    config: undefined,
    declaredPackages: resolved(new Set<string>()),
    bundlers: resolved(new Set<Bundler>(["turbopack"])),
    typeScriptMajor: unresolved("no installed typescript in this fixture"),
    pageExtensions: resolved(DEFAULT_PAGE_EXTENSIONS),
  };
  const sources = scanSources(root);
  return {
    project: context,
    tree: buildRouteTree({
      appDirectory: appDirectory.path,
      pageExtensions: DEFAULT_PAGE_EXTENSIONS,
      isFlagEnabled: () => true,
    }),
    sources,
    graph: buildGraph(sources),
    isFlagEnabled: () => true,
    // No build is read in these tests: every predicate here answers from source alone.
    build: unresolved("no build was read"),
    join: EMPTY_JOIN,
  };
}

function surface(id: string): SurfaceEntry {
  return {
    id,
    domain: "components",
    title: id,
    relatedLinks: [],
    docPath: `/docs/${id}.md`,
    frontmatterFailed: false,
    docRelativePath: "",
    docUrl: "",
    adoptable: true,
  };
}

const predicateFor = (id: string) => {
  const found = COMPONENT_PREDICATES.find((predicate) => predicate.id === id);
  if (!found) throw new Error(`no predicate for ${id}`);
  return found;
};

const used = (id: string, context: PredicateContext) =>
  predicateFor(id).detectUsed(context, surface(id));
const applies = (id: string, context: PredicateContext) =>
  predicateFor(id).wouldApply?.(context, surface(id));

describe("import-anchored detection", () => {
  it("should count a component imported from its module", () => {
    const context = project({ "app/a.tsx": "import Image from 'next/image'\n" });
    expect(used("components/image", context).matched).toBe(true);
  });

  it("should ignore a project's own component of the same name", () => {
    const context = project({ "app/a.tsx": "import Image from './my-image'\n" });
    expect(used("components/image", context).matched).toBe(false);
  });

  it("should count either font loader as the font entry", () => {
    const google = project({ "app/a.ts": "import { Inter } from 'next/font/google'\n" });
    const local = project({ "app/a.ts": "import localFont from 'next/font/local'\n" });
    expect(used("components/font", google).matched).toBe(true);
    expect(used("components/font", local).matched).toBe(true);
  });

  it("should count a component imported only by a test file", () => {
    const context = project({ "app/a.test.tsx": "import Link from 'next/link'\n" });
    expect(used("components/link", context).matched).toBe(true);
  });
});

describe("raw element heuristics", () => {
  it("should suggest the image component for a raw img in production code", () => {
    const context = project({ "app/a.tsx": "export const A = () => <img src='/a.png' />\n" });
    expect(applies("components/image", context)?.matched).toBe(true);
  });

  it("should stay silent for a raw img rendered only by a test", () => {
    const context = project({ "app/a.test.tsx": "export const A = () => <img src='/a.png' />\n" });
    expect(applies("components/image", context)?.matched).toBe(false);
  });

  it("should stay silent for an img written inside a comment", () => {
    const context = project({
      "app/a.tsx": "export const A = () => {\n  // <img src='/a.png' />\n  return null\n}\n",
    });
    expect(applies("components/image", context)?.matched).toBe(false);
  });

  it("should suggest the link component for an internal anchor", () => {
    const context = project({ "app/a.tsx": "export const A = () => <a href='/about'>x</a>\n" });
    expect(applies("components/link", context)?.matched).toBe(true);
  });

  it("should stay silent for an external anchor", () => {
    const context = project({
      "app/a.tsx": "export const A = () => <a href='https://x.com'>x</a>\n",
    });
    expect(applies("components/link", context)?.matched).toBe(false);
  });

  it("should stay silent for a protocol-relative anchor", () => {
    const context = project({ "app/a.tsx": "export const A = () => <a href='//x.com'>x</a>\n" });
    expect(applies("components/link", context)?.matched).toBe(false);
  });

  it("should stay silent for a computed anchor target", () => {
    const context = project({ "app/a.tsx": "export const A = ({u}) => <a href={u}>x</a>\n" });
    expect(applies("components/link", context)?.matched).toBe(false);
  });
});

describe("script heuristics", () => {
  it("should suggest the script component for a third-party script", () => {
    const context = project({
      "app/a.tsx": "export const A = () => <script src='https://cdn.x.com/a.js' />\n",
    });
    expect(applies("components/script", context)?.matched).toBe(true);
  });

  it("should never suggest replacing a JSON-LD block", () => {
    const context = project({
      "app/a.tsx":
        "export const A = () => <script type='application/ld+json' src='https://x.com/a.js' />\n",
    });
    expect(applies("components/script", context)?.matched).toBe(false);
  });
});

describe("image attribute conditions", () => {
  it("should report fill without sizes", () => {
    const context = project({
      "app/a.tsx": "import Image from 'next/image'\nexport const A = () => <Image fill />\n",
    });
    const verdict = applies("components/image", context);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("full viewport");
  });

  it("should stay silent when fill carries sizes", () => {
    const context = project({
      "app/a.tsx":
        "import Image from 'next/image'\nexport const A = () => <Image fill sizes='100vw' />\n",
    });
    expect(applies("components/image", context)?.matched).toBe(false);
  });

  it("should report the deprecated priority attribute", () => {
    const context = project({
      "app/a.tsx": "import Image from 'next/image'\nexport const A = () => <Image priority />\n",
    });
    expect(applies("components/image", context)?.note).toContain("deprecated");
  });
});

describe("font heuristics", () => {
  it("should suggest the font module for a remote font stylesheet", () => {
    const context = project({
      "app/a.tsx":
        "export const A = () => <link href='https://fonts.googleapis.com/css2?family=Inter' />\n",
    });
    expect(applies("components/font", context)?.matched).toBe(true);
  });

  it("should stay silent for a font stylesheet referenced only by a test", () => {
    const context = project({
      "app/a.test.tsx":
        "export const A = () => <link href='https://fonts.googleapis.com/css2' />\n",
    });
    expect(applies("components/font", context)?.matched).toBe(false);
  });
});

/**
 * The raw form, against the vendored project holding one that navigates and three that do not.
 * The component is for a form whose fields become search parameters on a route; everything else a
 * form can do is somebody's server function, and this entry has nothing to say about those.
 */
describe("a raw form the component is for", () => {
  const verdict = () => applies("components/form", fixtureContext("incomplete-app"));

  it("should cite the form navigating to a path it names", () => {
    expect(verdict()?.evidence).toEqual([fileIn("incomplete-app", "app", "busqueda", "page.tsx")]);
  });

  it("should leave a server-action form, a computed action and a post alone", () => {
    expect(verdict()?.evidence).not.toContain(fileIn("incomplete-app", "app", "envio", "page.tsx"));
  });

  it("should say what the component buys", () => {
    expect(verdict()?.gain).toContain("prefetches");
  });
});

describe("a raw form read one attribute at a time", () => {
  const form = (markup: string) =>
    applies("components/form", project({ "app/a.tsx": `export default () => (${markup})\n` }));

  it("should read a literal get as a navigation", () => {
    expect(form('<form action="/buscar" method="get" />')?.matched).toBe(true);
  });

  it("should not read an external action as one", () => {
    expect(form('<form action="https://ejemplo.com/buscar" />')?.matched).toBe(false);
  });

  /**
   * A method written as an expression leaves the question open, which is not the same as a form
   * with no method at all. Read as absent it would report a form that posts.
   */
  it("should leave a form whose method is an expression alone", () => {
    expect(form('<form action="/buscar" method={verbo} />')?.matched).toBe(false);
  });

  /**
   * The handler is where a form cancels the navigation and submits by hand. Whether this one does
   * needs its body, and the message states that the form navigates — so a form carrying one is a
   * form this condition cannot describe.
   */
  it("should leave a form carrying a submit handler alone", () => {
    expect(form('<form action="/buscar" method="get" onSubmit={enviar} />')?.matched).toBe(false);
  });
});

describe("an img the project exempted on purpose", () => {
  const RULE = "@next/next/no-img-element";
  const IMG = "export const A = () => <img src='/a.png' />\n";

  /**
   * The project's lint configuration already answered this. `ECarry/photography-website` disables
   * the rule at the top of the file its Tiptap node view lives in, and was told to adopt the Image
   * component there anyway — a suggestion arguing with a decision its author had written down.
   */
  it("should stay silent for an img under a file-wide disable naming the rule", () => {
    const context = project({ "app/a.tsx": `/* eslint-disable ${RULE} */\n${IMG}` });
    expect(applies("components/image", context)?.matched).toBe(false);
  });

  it("should stay silent for an img disabled on its own line", () => {
    const context = project({
      "app/a.tsx": `export const A = () => <img src='/a.png' /> // eslint-disable-line ${RULE}\n`,
    });
    expect(applies("components/image", context)?.matched).toBe(false);
  });

  it("should stay silent for an img disabled on the line above", () => {
    const context = project({
      "app/a.tsx": `export const A = () =>\n  // eslint-disable-next-line ${RULE}\n  <img src='/a.png' />\n`,
    });
    expect(applies("components/image", context)?.matched).toBe(false);
  });

  /** A disable about something else says nothing about this question. */
  it("should still report an img under a disable naming a different rule", () => {
    const context = project({ "app/a.tsx": `/* eslint-disable react/no-danger */\n${IMG}` });
    expect(applies("components/image", context)?.matched).toBe(true);
  });

  /** A blanket disable is a convenience, not an argument about this rule. */
  it("should still report an img under a blanket disable naming no rule", () => {
    const context = project({ "app/a.tsx": `/* eslint-disable */\n${IMG}` });
    expect(applies("components/image", context)?.matched).toBe(true);
  });

  /** Line-scoped means line-scoped: the exemption does not spread to the rest of the file. */
  it("should still report an uncovered img beside an exempted one", () => {
    const context = project({
      "app/a.tsx": [
        `// eslint-disable-next-line ${RULE}`,
        "const exempt = <img src='/a.png' />;",
        "const reported = <img src='/b.png' />;",
        "export const A = () => [exempt, reported];",
      ].join("\n"),
    });
    const verdict = applies("components/image", context);
    expect(verdict?.matched).toBe(true);
  });

  /** The other two branches read attributes rather than lines, and are untouched by this. */
  it("should still report fill without sizes in a file that disables the img rule", () => {
    const context = project({
      "app/a.tsx": `/* eslint-disable ${RULE} */\nimport Image from 'next/image'\nexport const A = () => <Image fill src='/a.png' />\n`,
    });
    const verdict = applies("components/image", context);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("sizes");
  });
});
