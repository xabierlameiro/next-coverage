import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureRoot } from "../../test-support/corpus.js";
import { once } from "../../test-support/fixtures.js";
import { buildBoundary } from "./boundary.js";
import { buildGraph } from "./graph.js";
import { scanSources } from "./sources.js";

function syntheticProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-boundary-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function boundaryOf(files: Record<string, string>) {
  const root = syntheticProject(files);
  const index = scanSources(root);
  return {
    report: buildBoundary(index, buildGraph(index)),
    at: (name: string) => join(root, name),
  };
}

const CLIENT = "'use client'\n";
const SERVER = "'use server'\n";

describe("boundary leaks", () => {
  it("should report a module on the client side that imports server-only", () => {
    const { report, at } = boundaryOf({
      "a.tsx": `${CLIENT}import { secret } from './secrets'\nexport const A = secret\n`,
      "secrets.ts": "import 'server-only'\nexport const secret = 1\n",
    });
    expect(report.leaks).toEqual([
      {
        module: at("secrets.ts"),
        specifier: "server-only",
        chain: [at("a.tsx"), at("secrets.ts")],
      },
    ]);
  });

  it("should show the barrel in the chain, so the reader can judge the finding", () => {
    const { report, at } = boundaryOf({
      "a.tsx": `${CLIENT}import { label } from './utils'\nexport const A = label\n`,
      "utils/index.ts": "export * from './label'\nexport * from './secrets'\n",
      "utils/label.ts": "export const label = 'x'\n",
      "utils/secrets.ts": "import 'server-only'\nexport const secret = 1\n",
    });
    // The graph joins files, not symbols, so a barrel re-exporting a server module reaches it.
    expect(report.leaks[0]?.chain).toEqual([
      at("a.tsx"),
      at("utils/index.ts"),
      at("utils/secrets.ts"),
    ]);
  });

  it("should report a framework module that only exists on the server", () => {
    const { report } = boundaryOf({
      "a.tsx": `${CLIENT}import { read } from './read'\nexport const A = read\n`,
      "read.ts": "import { cookies } from 'next/headers'\nexport const read = cookies\n",
    });
    expect(report.leaks.map((leak) => leak.specifier)).toEqual(["next/headers"]);
  });

  it("should not report a server module the client side never reaches", () => {
    const { report } = boundaryOf({
      "a.tsx": `${CLIENT}export const A = 1\n`,
      "secrets.ts": "import 'server-only'\nexport const secret = 1\n",
    });
    expect(report.leaks).toEqual([]);
  });

  it("should not report through a server action, which is referenced rather than bundled", () => {
    const { report } = boundaryOf({
      "a.tsx": `${CLIENT}import { save } from './action'\nexport const A = save\n`,
      "action.ts": `${SERVER}import 'server-only'\nexport async function save() { return 1 }\n`,
    });
    expect(report.leaks).toEqual([]);
  });

  it("should not report through a type-only import, which does not exist at runtime", () => {
    const { report } = boundaryOf({
      "a.tsx": `${CLIENT}import type { S } from './secrets'\nexport const A: S = 1\n`,
      "secrets.ts": "import 'server-only'\nexport type S = number\n",
    });
    expect(report.leaks).toEqual([]);
  });

  it("should report a client file that imports server-only itself", () => {
    const { report, at } = boundaryOf({
      "a.tsx": `${CLIENT}import 'server-only'\nexport const A = 1\n`,
    });
    expect(report.leaks[0]?.chain).toEqual([at("a.tsx")]);
  });

  it("should carry the figures the report discloses", () => {
    const { report } = boundaryOf({
      "a.tsx": `${CLIENT}import { b } from './b'\nimport { gone } from './gone'\nexport const A = b\n`,
      "b.ts": "export const b = 1\n",
    });
    expect(report.closure).toBe(2);
    expect(report.reachedWithoutDeclaring).toBe(1);
    expect(report.unresolvedSpecifiers).toBe(1);
  });
});

function examinedBoundaryOf(files: Record<string, string>) {
  const root = syntheticProject(files);
  const index = scanSources(root);
  return {
    report: buildBoundary(index, buildGraph(index), { examineDirectives: true }),
    at: (name: string) => join(root, name),
  };
}

describe("a directive the file does not use", () => {
  it("should not run unless the caller asks, so a withheld channel reports nothing", () => {
    const { report } = boundaryOf({ "a.tsx": `${CLIENT}export const A = () => null\n` });
    expect(report.directivesWithoutReason).toBeUndefined();
  });

  it("should report a client entry showing none of the documented reasons, with its count", () => {
    const { report, at } = examinedBoundaryOf({
      "a.tsx": `${CLIENT}import { t } from './text'\nexport const A = () => <p>{t}</p>\n`,
      "text.ts": "export const t = 'x'\n",
    });
    expect(report.directivesWithoutReason).toEqual([{ module: at("a.tsx"), exclusiveModules: 1 }]);
  });

  it("should be present and empty where the examination ran and every entry shows a reason", () => {
    const { report } = examinedBoundaryOf({
      "a.tsx": `${CLIENT}import { useState } from 'react'\nexport const A = () => useState(0)\n`,
    });
    expect(report.directivesWithoutReason).toEqual([]);
  });

  it("should say zero for a leaf entry, because a directive nothing uses is still one", () => {
    const { report, at } = examinedBoundaryOf({
      "a.tsx": `${CLIENT}export const A = () => <p>x</p>\n`,
    });
    expect(report.directivesWithoutReason).toEqual([{ module: at("a.tsx"), exclusiveModules: 0 }]);
  });

  it("should not report a file another entry already reaches, whose directive decides nothing", () => {
    const { report, at } = examinedBoundaryOf({
      "a.tsx": `${CLIENT}import { useState } from 'react'\nimport { I } from './inner'\nexport const A = () => useState(I)\n`,
      "inner.tsx": `${CLIENT}export const I = 1\n`,
    });
    expect(report.directivesWithoutReason?.map((found) => found.module)).not.toContain(
      at("inner.tsx"),
    );
  });

  it("should not report an entry importing client code another entry also reaches", () => {
    const { report, at } = examinedBoundaryOf({
      "a.tsx": `${CLIENT}import { h } from './helper'\nexport const A = () => <p>{h}</p>\n`,
      "b.tsx": `${CLIENT}import { h } from './helper'\nexport const B = () => document.title + h\n`,
      "helper.ts": "export const h = 1\n",
    });
    // Its helper is on the client whatever `a.tsx` declares, so its own directive carries nothing
    // the report can attribute to it.
    expect(report.directivesWithoutReason?.map((found) => found.module)).not.toContain(at("a.tsx"));
  });

  it("should not report a test file", () => {
    const { report } = examinedBoundaryOf({
      "a.test.tsx": `${CLIENT}export const A = () => <p>x</p>\n`,
    });
    expect(report.directivesWithoutReason).toEqual([]);
  });

  it("should order the largest exclusive reach first", () => {
    const { report, at } = examinedBoundaryOf({
      "small.tsx": `${CLIENT}export const S = () => <p>s</p>\n`,
      "big.tsx": `${CLIENT}import { h } from './helper'\nexport const B = () => <p>{h}</p>\n`,
      "helper.ts": "export const h = 1\n",
    });
    expect(report.directivesWithoutReason?.map((found) => found.module)).toEqual([
      at("big.tsx"),
      at("small.tsx"),
    ]);
  });
});

describe("the vendored project holding both shapes", () => {
  const root = fixtureRoot("sparse-app");
  const report = once("sparse-boundary", () => {
    const index = scanSources(root);
    return buildBoundary(index, buildGraph(index), { examineDirectives: true });
  });

  it("should report the file that shows no reason, with what it alone brings to the client", () => {
    expect(report.directivesWithoutReason).toEqual([
      { module: join(root, "app", "informe", "Aviso.tsx"), exclusiveModules: 1 },
    ]);
  });

  it("should say nothing about the files in the same project that call a hook", () => {
    const reported = report.directivesWithoutReason?.map((found) => found.module) ?? [];
    expect(reported).not.toContain(join(root, "app", "panel", "Navegacion.tsx"));
    expect(reported).not.toContain(join(root, "app", "panel", "Filtros.tsx"));
    expect(reported).not.toContain(join(root, "app", "ajustes", "layout.tsx"));
  });
});

describe("a directive that exists to render an imported component", () => {
  const MANIFEST = JSON.stringify({ dependencies: { "next-themes": "1.0.0" } });

  /**
   * The shape the survey found three times over in one project, and it is the canonical one for a
   * shadcn/ui codebase: a file whose whole job is to make a third-party client library usable from
   * a Server Component. It writes none of the six reasons a file alone can show.
   */
  it("should not report an entry that wraps a dependency's component", () => {
    const { report } = examinedBoundaryOf({
      "package.json": MANIFEST,
      "theme-provider.tsx": `${CLIENT}import { ThemeProvider } from 'next-themes'\nexport const P = ({ children }) => <ThemeProvider>{children}</ThemeProvider>\n`,
    });
    expect(report.directivesWithoutReason).toEqual([]);
  });

  /** Narrowed, not silenced: an entry rendering only its own markup still shows no reason. */
  it("should still report an entry rendering a plain element", () => {
    const { report, at } = examinedBoundaryOf({
      "package.json": MANIFEST,
      "plain.tsx": `${CLIENT}import { t } from './text'\nexport const A = () => <p>{t}</p>\n`,
      "text.ts": "export const t = 'x'\n",
    });
    expect(report.directivesWithoutReason).toEqual([
      { module: at("plain.tsx"), exclusiveModules: 1 },
    ]);
  });
});
