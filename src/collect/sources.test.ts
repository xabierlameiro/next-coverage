import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_FIXTURE } from "../../test-support/corpus.js";
import {
  excludedFromProgram,
  filesImporting,
  filesImportingModule,
  findSourceFiles,
  foreignPackages,
  hasDirective,
  linkedPackages,
  scanSources,
  unversionedDirectories,
} from "./sources.js";

function syntheticProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-src-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

describe("scan boundaries", () => {
  it("should skip dependency, build and hidden directories", () => {
    const root = syntheticProject({
      "app/page.tsx": "export default function P() { return null }\n",
      "node_modules/dep/index.ts": "export const x = 1\n",
      ".next/server/chunk.js": "module.exports = {}\n",
      "dist/out.js": "export const y = 2\n",
      "coverage/report.js": "export const z = 3\n",
      ".hidden/thing.ts": "export const w = 4\n",
    });
    const found = findSourceFiles(root).map((p) => p.slice(root.length + 1));
    expect(found).toEqual([join("app", "page.tsx")]);
  });

  it("should skip a directory the project says it does not version", () => {
    // The measured case: a test reporter's output, versioned nowhere, holding bundles whose
    // imports resolve to chunks that are not there.
    const root = syntheticProject({
      ".gitignore": "/playwright-report/\n",
      "app/page.tsx": "export default function P() { return null }\n",
      "playwright-report/trace/bundle.js": "import './assets/missing.js'\n",
    });
    const found = findSourceFiles(root).map((p) => p.slice(root.length + 1));
    expect(found).toEqual([join("app", "page.tsx")]);
  });

  it("should scan that same directory when the project records nothing", () => {
    // The pair that makes the previous case about the record rather than about the name.
    const root = syntheticProject({
      "app/page.tsx": "export default function P() { return null }\n",
      "playwright-report/trace/bundle.js": "import './assets/missing.js'\n",
    });
    const found = findSourceFiles(root).map((p) => p.slice(root.length + 1));
    expect(found).toEqual([
      join("app", "page.tsx"),
      join("playwright-report", "trace", "bundle.js"),
    ]);
  });

  it("should skip the fixed directories whatever the record says", () => {
    const root = syntheticProject({
      ".gitignore": "*.log\n",
      "app/page.tsx": "export default function P() { return null }\n",
      "node_modules/dep/index.ts": "export const x = 1\n",
    });
    const found = findSourceFiles(root).map((p) => p.slice(root.length + 1));
    expect(found).toEqual([join("app", "page.tsx")]);
  });

  it("should skip declaration files", () => {
    const root = syntheticProject({
      "types.d.ts": "export type X = string\n",
      "app/page.tsx": "export default function P() { return null }\n",
    });
    expect(findSourceFiles(root)).toHaveLength(1);
  });

  it("should scan test files, because these APIs are legitimately used there", () => {
    const root = syntheticProject({
      "app/page.test.tsx": "import { cookies } from 'next/headers'\n",
    });
    expect(filesImporting(scanSources(root), "next/headers", "cookies")).toHaveLength(1);
  });

  it("should return files in a stable order", () => {
    const root = syntheticProject({
      "b.ts": "export const b = 1\n",
      "a.ts": "export const a = 1\n",
    });
    expect(findSourceFiles(root)).toEqual([...findSourceFiles(root)].sort());
  });
});

describe("imports", () => {
  it("should record a named import against its module", () => {
    const root = syntheticProject({ "a.ts": "import { cacheTag } from 'next/cache'\n" });
    const [file] = scanSources(root).files;
    expect(file?.imports.get("next/cache")).toEqual([
      { imported: "cacheTag", local: "cacheTag", typeOnly: false },
    ]);
  });

  it("should keep both names when an import is aliased", () => {
    const root = syntheticProject({ "a.ts": "import { cacheTag as tag } from 'next/cache'\n" });
    const [file] = scanSources(root).files;
    expect(file?.imports.get("next/cache")?.[0]).toEqual({
      imported: "cacheTag",
      local: "tag",
      typeOnly: false,
    });
  });

  it("should mark a type-only import so it never counts as a use", () => {
    const root = syntheticProject({
      "a.ts": "import type { NextRequest } from 'next/server'\n",
      "b.ts": "import { type NextResponse } from 'next/server'\n",
    });
    const index = scanSources(root);
    expect(filesImporting(index, "next/server", "NextRequest")).toEqual([]);
    expect(filesImporting(index, "next/server", "NextResponse")).toEqual([]);
    expect(filesImportingModule(index, "next/server")).toHaveLength(2);
  });

  it("should record a side-effect import with no bindings", () => {
    const root = syntheticProject({ "a.ts": "import 'server-only'\n" });
    const [file] = scanSources(root).files;
    expect(file?.imports.get("server-only")).toEqual([]);
  });

  it("should record default and namespace imports", () => {
    const root = syntheticProject({
      "a.ts": "import Link from 'next/link'\nimport * as nav from 'next/navigation'\n",
    });
    const [file] = scanSources(root).files;
    expect(file?.imports.get("next/link")?.[0]?.imported).toBe("default");
    expect(file?.imports.get("next/navigation")?.[0]?.imported).toBe("*");
  });
});

describe("directives", () => {
  it("should record a file prologue directive", () => {
    const root = syntheticProject({ "a.ts": "'use cache'\nexport const x = 1\n" });
    const [file] = scanSources(root).files;
    expect(file?.fileDirectives).toEqual(["use cache"]);
  });

  it("should distinguish the cache directive variants", () => {
    const root = syntheticProject({ "a.ts": "'use cache: private'\nexport const x = 1\n" });
    const [file] = scanSources(root).files;
    expect(file?.fileDirectives).toEqual(["use cache: private"]);
  });

  it("should record a function-level directive separately from the prologue", () => {
    const root = syntheticProject({
      "a.ts": "export async function get() {\n  'use cache'\n  return 1\n}\n",
    });
    const [file] = scanSources(root).files;
    if (!file) throw new Error("expected the file to be scanned");
    expect(file.fileDirectives).toEqual([]);
    expect(file.functionDirectives).toEqual(["use cache"]);
    expect(hasDirective(file, "use cache")).toBe(true);
  });
});

describe("exports", () => {
  it("should record an exported function declaration by name", () => {
    const root = syntheticProject({
      "a.ts": "export async function generateStaticParams() { return [] }\n",
    });
    expect(scanSources(root).files[0]?.exportedNames).toContain("generateStaticParams");
  });

  it("should record an exported const by name", () => {
    const root = syntheticProject({ "a.ts": "export const metadata = {}\n" });
    expect(scanSources(root).files[0]?.exportedNames).toContain("metadata");
  });

  it("should record a default export as default, not as a name", () => {
    const root = syntheticProject({ "a.ts": "export default function P() { return null }\n" });
    const [file] = scanSources(root).files;
    expect(file?.hasDefaultExport).toBe(true);
    expect(file?.exportedNames).toEqual([]);
  });
});

describe("asynchronous default export", () => {
  const asyncDefaultOf = (contents: string) => {
    const root = syntheticProject({ "a.tsx": contents });
    return scanSources(root).files[0]?.hasAsyncDefaultExport;
  };

  it("should record an async function declaration exported by default", () => {
    expect(asyncDefaultOf("export default async function Page() { return null }\n")).toBe(true);
  });

  it("should record an anonymous async function exported by default", () => {
    expect(asyncDefaultOf("export default async function () { return null }\n")).toBe(true);
  });

  it("should record an async arrow exported by default", () => {
    expect(asyncDefaultOf("export default async () => null\n")).toBe(true);
  });

  it("should record an async function expression exported by default", () => {
    expect(asyncDefaultOf("export default (async function () { return null })\n")).toBe(true);
  });

  it("should not record a synchronous default export", () => {
    expect(asyncDefaultOf("export default function Page() { return null }\n")).toBe(false);
  });

  // The declaration is the only thing read; resolving the identifier would need a second pass.
  it("should not record a default export whose declaration is elsewhere", () => {
    expect(asyncDefaultOf("async function Page() { return null }\nexport default Page\n")).toBe(
      false,
    );
  });

  it("should not record a re-exported default", () => {
    expect(asyncDefaultOf("export { default } from './page'\n")).toBe(false);
  });

  it("should not record a file with no default export", () => {
    expect(asyncDefaultOf("export async function generateMetadata() { return {} }\n")).toBe(false);
  });
});

describe("extended fetch", () => {
  it("should record a fetch carrying a next option", () => {
    const root = syntheticProject({
      "a.ts": "await fetch('/x', { next: { tags: ['a'] } })\n",
    });
    expect(scanSources(root).files[0]?.extendedFetchCalls).toBe(1);
  });

  it("should not record a plain platform fetch", () => {
    const root = syntheticProject({
      "a.ts": "await fetch('/x')\nawait fetch('/y', { method: 'POST' })\n",
    });
    expect(scanSources(root).files[0]?.extendedFetchCalls).toBe(0);
  });
});

describe("a constant the file declares", () => {
  const tagIn = (body: string) =>
    scanSources(
      syntheticProject({ "a.ts": `import { cacheTag } from 'next/cache'\n${body}\n` }),
    ).files[0]?.calls.find((call) => call.callee === "cacheTag")?.args[0];

  it("should resolve an identifier to the literal the file assigns it", () => {
    expect(tagIn("const T = 'x'\nexport const a = () => cacheTag(T)")).toEqual({ literal: "x" });
  });

  it("should resolve a name declared after the call that reads it", () => {
    expect(tagIn("export const a = () => cacheTag(T)\nconst T = 'x'")).toEqual({ literal: "x" });
  });

  it("should refuse a name the file declares with let", () => {
    expect(tagIn("let T = 'x'\nexport const a = () => cacheTag(T)")).toBe("unresolved");
  });

  it("should refuse a name declared more than once", () => {
    expect(
      tagIn("const T = 'x'\nfunction f() { const T = 'y'; return T }\nconst a = cacheTag(T)"),
    ).toBe("unresolved");
  });

  it("should refuse a name shadowed by a parameter", () => {
    expect(tagIn("const T = 'x'\nexport const a = (T) => cacheTag(T)")).toBe("unresolved");
  });

  it("should refuse a name the file imports", () => {
    expect(
      scanSources(
        syntheticProject({
          "a.ts":
            "import { cacheTag } from 'next/cache'\nimport { T } from './t'\nexport const a = () => cacheTag(T)\n",
        }),
      ).files[0]?.calls.find((call) => call.callee === "cacheTag")?.args[0],
    ).toBe("unresolved");
  });

  it("should refuse a name assigned again after its declaration", () => {
    expect(tagIn("const T = 'x'\nexport const a = () => { T = 'y'; return cacheTag(T) }")).toBe(
      "unresolved",
    );
  });

  it("should refuse a constant whose initialiser is not a literal", () => {
    expect(tagIn("const T = compute()\nexport const a = () => cacheTag(T)")).toBe("unresolved");
  });
});

describe("tags on the deprecated cache helper", () => {
  const callIn = (body: string) =>
    scanSources(
      syntheticProject({ "a.ts": `import { unstable_cache } from 'next/cache'\n${body}\n` }),
    ).files[0]?.calls.find((call) => call.callee === "unstable_cache");

  it("should record literal tags from the options argument", () => {
    expect(callIn("const r = unstable_cache(f, ['k'], { tags: ['a', 'b'] })")?.optionTags).toEqual([
      { literal: "a" },
      { literal: "b" },
    ]);
  });

  it("should record a tags value that is not an array as unresolved", () => {
    expect(callIn("const r = unstable_cache(f, ['k'], { tags: names })")?.optionTags).toEqual([
      "unresolved",
    ]);
  });

  it("should record nothing for a call with no options argument", () => {
    expect(callIn("const r = unstable_cache(f, ['k'])")?.optionTags).toEqual([]);
  });

  it("should record nothing when the options argument is not an object literal", () => {
    expect(callIn("const r = unstable_cache(f, ['k'], options)")?.optionTags).toEqual([]);
  });

  it("should record nothing when the options argument carries no tags", () => {
    expect(callIn("const r = unstable_cache(f, ['k'], { revalidate: false })")?.optionTags).toEqual(
      [],
    );
  });
});

describe("module references", () => {
  const projectWith = (main: string) =>
    syntheticProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { moduleResolution: "bundler", paths: { "@/*": ["./app/*"] } },
      }),
      "app/main.ts": main,
      "app/helper.ts": "export const x = 1\nexport type X = string\n",
    });
  const mainOf = (root: string) => scanSources(root).files.find((f) => f.path.endsWith("main.ts"));

  it("should mark an import declared type-only", () => {
    const file = mainOf(projectWith("import type { X } from './helper'\n"));
    expect(file?.moduleReferences).toEqual([
      expect.objectContaining({ specifier: "./helper", kind: "import", typeOnly: true }),
    ]);
  });

  it("should mark an import whose every specifier is a type", () => {
    const file = mainOf(projectWith("import { type X } from './helper'\n"));
    expect(file?.moduleReferences[0]?.typeOnly).toBe(true);
  });

  it("should not mark an import that brings one value among types", () => {
    const file = mainOf(projectWith("import { type X, x } from './helper'\n"));
    expect(file?.moduleReferences[0]?.typeOnly).toBe(false);
  });

  it("should record a side-effect import, which brings no names and is still an edge", () => {
    const file = mainOf(projectWith("import './helper'\n"));
    expect(file?.moduleReferences[0]).toMatchObject({ kind: "import", typeOnly: false });
  });

  it("should record a re-export as a reference to that module", () => {
    const file = mainOf(projectWith("export * from './helper'\n"));
    expect(file?.moduleReferences[0]).toMatchObject({ kind: "reexport", typeOnly: false });
  });

  it("should mark a type-only re-export", () => {
    const file = mainOf(projectWith("export type { X } from './helper'\n"));
    expect(file?.moduleReferences[0]?.typeOnly).toBe(true);
  });

  it("should record a dynamic import written with a literal", () => {
    const file = mainOf(projectWith("const p = import('./helper')\n"));
    expect(file?.moduleReferences[0]).toMatchObject({ kind: "dynamic", specifier: "./helper" });
  });

  it("should record nothing for a dynamic import with a computed specifier", () => {
    const file = mainOf(projectWith("const name = 'helper'\nconst p = import('./' + name)\n"));
    expect(file?.moduleReferences).toEqual([]);
  });

  it("should resolve an alias to the file it names", () => {
    const file = mainOf(projectWith("import { x } from '@/helper'\n"));
    expect(file?.moduleReferences[0]?.resolution).toMatchObject({ kind: "internal" });
  });

  it("should count how every specifier resolved", () => {
    const root = syntheticProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "bundler" } }),
      "app/main.ts": "import { x } from './helper'\nimport { y } from 'dep'\nimport './gone'\n",
      "app/helper.ts": "export const x = 1\n",
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", main: "index.js" }),
      "node_modules/dep/index.ts": "export const y = 2\n",
    });
    expect(scanSources(root).resolution).toEqual({
      internal: 1,
      external: 1,
      unresolved: 1,
      assets: 0,
      missingPackages: [],
    });
  });

  it("should keep a stylesheet and an absent package out of the unresolved count", () => {
    const root = syntheticProject({
      "package.json": JSON.stringify({ dependencies: { declared: "^1.0.0" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "bundler" } }),
      "app/main.ts":
        "import './a.css'\nimport { x } from 'declared'\nimport { y } from 'undeclared'\n",
    });
    const { resolution } = scanSources(root);
    expect(resolution.unresolved).toBe(0);
    expect(resolution.assets).toBe(1);
    expect(resolution.missingPackages).toEqual([
      { name: "declared", declared: "yes", references: 1 },
      { name: "undeclared", declared: "no", references: 1 },
    ]);
  });

  it("should count one absent package once, however many files name it", () => {
    const root = syntheticProject({
      "package.json": JSON.stringify({}),
      "tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "bundler" } }),
      "app/a.ts": "import { x } from 'gone'\n",
      "app/b.ts": "import { y } from 'gone'\n",
    });
    expect(scanSources(root).resolution.missingPackages).toEqual([
      { name: "gone", declared: "no", references: 2 },
    ]);
  });

  it("should keep references in source order", () => {
    const file = mainOf(projectWith("import './helper'\nexport * from './helper'\n"));
    expect(file?.moduleReferences.map((reference) => reference.kind)).toEqual([
      "import",
      "reexport",
    ]);
  });
});

describe("exported literal values", () => {
  function literalsOf(contents: string) {
    const root = syntheticProject({ "app/page.tsx": contents });
    const index = scanSources(root);
    return index.byPath.get(join(root, "app", "page.tsx"))?.exportedLiterals;
  }

  it("should record the value of an exported const initialised to a string", () => {
    const literals = literalsOf("export const dynamic = 'force-static';\n");
    expect(literals?.get("dynamic")).toBe("force-static");
  });

  it("should record the name and no value for a computed initialiser", () => {
    const root = syntheticProject({
      "app/page.tsx": "const mode = process.env.MODE;\nexport const dynamic = mode;\n",
    });
    const record = scanSources(root).byPath.get(join(root, "app", "page.tsx"));
    expect(record?.exportedNames).toContain("dynamic");
    expect(record?.exportedLiterals.has("dynamic")).toBe(false);
  });

  it("should record no value for a number or a boolean", () => {
    const literals = literalsOf(
      "export const revalidate = 60;\nexport const dynamicParams = true;\n",
    );
    expect(literals?.has("revalidate")).toBe(false);
    expect(literals?.has("dynamicParams")).toBe(false);
  });

  it("should not fail on a declaration with no initialiser", () => {
    const root = syntheticProject({ "app/page.tsx": "export declare const dynamic: string;\n" });
    const record = scanSources(root).byPath.get(join(root, "app", "page.tsx"));
    expect(record?.exportedLiterals.size).toBe(0);
  });
});

describe("source values a file assigns", () => {
  /** One file, scanned, and its record back. */
  function recordOf(contents: string) {
    const root = syntheticProject({ "app/manifest.ts": contents });
    const index = scanSources(root);
    const record = index.files.find((file) => file.path.endsWith("manifest.ts"));
    if (record === undefined) throw new Error("expected the file to be scanned");
    return record;
  }

  it("should record a literal src", () => {
    const record = recordOf(
      "export default function m() { return { icons: [{ src: '/logo.png' }] }; }",
    );
    expect(record.srcValues).toEqual(["/logo.png"]);
  });

  it("should record a quoted property name too", () => {
    expect(recordOf("export const a = { 'src': '/a.png' };").srcValues).toEqual(["/a.png"]);
  });

  it("should record every source a file names", () => {
    const record = recordOf("export const a = { icons: [{ src: '/a.png' }, { src: '/b.png' }] };");
    expect(record.srcValues).toEqual(["/a.png", "/b.png"]);
  });

  it.each([
    ["a variable", "const v = '/a.png'; export const a = { src: v };"],
    ["a call", "export const a = { src: resolve('/a.png') };"],
    [
      "an interpolated template",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the scanned source, not our code
      "export const a = { src: `/${name}.png` };",
    ],
  ])("should record nothing for %s", (_label, code) => {
    // A source nobody wrote down is not a source. Recording it would let a rule report a path
    // that does not appear in the file.
    expect(recordOf(code).srcValues).toEqual([]);
  });

  it("should be empty for a file that assigns none", () => {
    expect(recordOf("export default function P() { return null; }").srcValues).toEqual([]);
  });
});

describe("the directories a project says it does not version", () => {
  const reading = (gitignore: string): ReadonlySet<string> =>
    unversionedDirectories(syntheticProject({ ".gitignore": gitignore }));

  it.each([
    ["bare", "playwright-report"],
    ["anchored", "/playwright-report"],
    ["trailing slash", "playwright-report/"],
    ["anchored with trailing slash", "/playwright-report/"],
  ])("should read a %s entry", (_shape, entry) => {
    expect([...reading(entry)]).toEqual(["playwright-report"]);
  });

  it.each([
    ["a wildcard", "*.log"],
    ["a single-character wildcard", "out?"],
    ["an interior path", "/e2e/test-results"],
  ])("should refuse %s, so the directory is still scanned", (_shape, entry) => {
    // A refusal scans, which is the behaviour before any of this existed. Reading one generated
    // file costs a figure; skipping one real source file costs an answer.
    expect([...reading(entry)]).toEqual([]);
  });

  it("should not skip a name the record re-includes", () => {
    // Ignored on one line and re-included on another is not a project calling it generated.
    expect([...reading("build\n!build\n")]).toEqual([]);
  });

  it("should ignore comments and blank lines", () => {
    expect([...reading("# a comment\n\n  /out/  \n")]).toEqual(["out"]);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("should read nothing from a record that is %s", (_state, contents) => {
    const root =
      contents === undefined ? syntheticProject({}) : syntheticProject({ ".gitignore": contents });
    expect([...unversionedDirectories(root)]).toEqual([]);
  });

  it("should read nothing from a root that does not exist", () => {
    expect([...unversionedDirectories(join(tmpdir(), "next-coverage-absent-root"))]).toEqual([]);
  });
});

describe("the workspace packages a project declares are not the application", () => {
  const lambda = JSON.stringify({ name: "handler", dependencies: { "aws-lambda": "1.0.0" } });
  const withNext = JSON.stringify({ name: "ui", dependencies: { next: "16.3.0" } });
  const relativeTo = (root: string) => (paths: ReadonlySet<string>) =>
    [...paths].map((path) => path.slice(root.length + 1)).sort();

  it.each([
    ["a children glob", "packages:\n  - 'aws-lambdas/*'\n"],
    ["a plain directory", "packages:\n  - 'aws-lambdas/one'\n"],
  ])("should read %s", (_shape, workspace) => {
    const root = syntheticProject({
      "pnpm-workspace.yaml": workspace,
      "package.json": JSON.stringify({ name: "app", dependencies: { next: "16.3.0" } }),
      "aws-lambdas/one/package.json": lambda,
      "aws-lambdas/one/index.ts": "export const handler = () => null\n",
    });
    expect(relativeTo(root)(foreignPackages(root))).toEqual([join("aws-lambdas", "one")]);
  });

  it("should read the manifest's own workspaces field", () => {
    const root = syntheticProject({
      "package.json": JSON.stringify({ name: "app", workspaces: ["services/*"] }),
      "services/mailer/package.json": lambda,
    });
    expect(relativeTo(root)(foreignPackages(root))).toEqual([join("services", "mailer")]);
  });

  it.each([
    ["a double wildcard", "packages:\n  - 'packages/**'\n"],
    ["an interior wildcard", "packages:\n  - 'pack*/one'\n"],
    ["a negation", "packages:\n  - '!packages/one'\n"],
  ])("should refuse %s, so the directory is still scanned", (_shape, workspace) => {
    const root = syntheticProject({
      "pnpm-workspace.yaml": workspace,
      "package.json": JSON.stringify({ name: "app" }),
      "packages/one/package.json": lambda,
    });
    expect([...foreignPackages(root)]).toEqual([]);
  });

  /**
   * Retention is by dependency, not by what a member's own manifest declares. Reading `next` in a
   * member's manifest answered a different question twice over: a plain library the app depends on
   * was dropped, and a sibling Next app it has nothing to do with was kept. Dropping a package full
   * of components importing `next/image` is still the expensive failure — and the dependency is
   * what says whether this project has one.
   */
  it("should keep a package the app depends on, whether or not it declares next", () => {
    const root = syntheticProject({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { next: "16.3.0", "@acme/ui": "workspace:*" },
      }),
      "packages/ui/package.json": JSON.stringify({
        name: "@acme/ui",
        dependencies: { next: "16.3.0" },
      }),
      "packages/mailer/package.json": lambda,
    });
    expect(relativeTo(root)(foreignPackages(root))).toEqual([join("packages", "mailer")]);
  });

  it("should skip a next-declaring sibling the app does not depend on", () => {
    const root = syntheticProject({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "package.json": JSON.stringify({ name: "app", dependencies: { next: "16.3.0" } }),
      "packages/ui/package.json": withNext,
    });
    expect(relativeTo(root)(foreignPackages(root))).toEqual([join("packages", "ui")]);
  });

  it.each([
    ["neither record exists", {}],
    ["the workspace record is unparseable", { "pnpm-workspace.yaml": "packages: [oh: no\n" }],
    [
      "a declared package directory is absent",
      { "pnpm-workspace.yaml": "packages:\n  - 'gone'\n" },
    ],
  ])("should read nothing when %s", (_state, files) => {
    const root = syntheticProject({ "package.json": JSON.stringify({ name: "app" }), ...files });
    expect([...foreignPackages(root)]).toEqual([]);
  });
});

describe("the directories a project excludes from its own program", () => {
  const relativeTo = (root: string) => (paths: ReadonlySet<string>) =>
    [...paths].map((path) => path.slice(root.length + 1)).sort();

  it("should read an entry through the comments and trailing commas a tsconfig may carry", () => {
    const root = syntheticProject({
      "tsconfig.json": '{\n  // a comment\n  "exclude": [\n    "generated",\n  ],\n}\n',
      "generated/client.ts": "export const c = 1\n",
    });
    expect(relativeTo(root)(excludedFromProgram(root))).toEqual(["generated"]);
  });

  it.each([
    ["a file", "playwright.config.ts"],
    ["a wildcard", "aws-lambdas/**/dist"],
    ["a path that is not there", "absent"],
  ])("should take nothing from %s", (_shape, entry) => {
    const root = syntheticProject({
      "tsconfig.json": JSON.stringify({ exclude: [entry] }),
      "playwright.config.ts": "export default {}\n",
    });
    // Excluding a file from a typecheck says nothing about whether the project owns it.
    expect([...excludedFromProgram(root)]).toEqual([]);
  });

  it("should not silence a same-named directory deeper in the tree", () => {
    const root = syntheticProject({
      "tsconfig.json": JSON.stringify({ exclude: ["infra"] }),
      "infra/stack.ts": "export const s = 1\n",
      "app/infra/client.ts": "export const c = 2\n",
    });
    const found = findSourceFiles(root).map((p) => p.slice(root.length + 1));
    expect(found).toEqual([join("app", "infra", "client.ts")]);
  });

  it.each([
    ["absent", undefined],
    ["unparseable", "{ not json at all "],
  ])("should read nothing from a config that is %s", (_state, contents) => {
    const root =
      contents === undefined
        ? syntheticProject({})
        : syntheticProject({ "tsconfig.json": contents });
    expect([...excludedFromProgram(root)]).toEqual([]);
  });
});

/** One file, scanned, for the two readings this family added to the walk. */
function scannedRecord(contents: string) {
  const root = syntheticProject({ "app/robots.ts": contents });
  const record = scanSources(root).files.find((file) => file.path.endsWith("robots.ts"));
  if (record === undefined) throw new Error("expected the file to be scanned");
  return record;
}

describe("the user agents a robots file names", () => {
  it("should record a literal a userAgent property names", () => {
    const record = scannedRecord(
      "export default function robots() { return { rules: [{ userAgent: 'Bingbot' }] }; }",
    );
    expect(record.userAgents).toEqual(["Bingbot"]);
  });

  it("should record every agent an array names", () => {
    const record = scannedRecord(
      "export default function robots() { return { rules: [{ userAgent: ['Bingbot', 'Applebot'] }] }; }",
    );
    expect(record.userAgents).toEqual(["Bingbot", "Applebot"]);
  });

  it("should record the wildcard, leaving what it means to the reader", () => {
    const record = scannedRecord(
      "export default function robots() { return { rules: [{ userAgent: '*' }] }; }",
    );
    expect(record.userAgents).toEqual(["*"]);
  });

  it.each([
    ["a variable", "const a = 'Bingbot'; export const r = { userAgent: a };"],
    ["a call", "export const r = { userAgent: agentsFor('bing') };"],
  ])("should record nothing for %s", (_label, code) => {
    // An agent assembled from a variable is a crawler nobody wrote down here, and a finding
    // naming one would name a string absent from the file it cites.
    expect(scannedRecord(code).userAgents).toEqual([]);
  });

  it("should record nothing where no userAgent is named", () => {
    expect(scannedRecord("export const r = { rules: [{ allow: '/' }] };").userAgents).toEqual([]);
  });
});

describe("the calls that consume a request body", () => {
  it.each(["text", "json", "formData", "arrayBuffer", "blob"])(
    "should record request.%s()",
    (method) => {
      const record = scannedRecord(
        `export default async function proxy(request) { await request.${method}(); }`,
      );
      expect(record.bodyReads).toEqual([{ receiver: "request", method }]);
    },
  );

  /**
   * The receiver is recorded because the five names are not the property of a request:
   * `NextResponse.json` is the commonest call in a proxy file, and a record naming only the method
   * would read every response built as a body consumed. Filtering is the reader's job, so this
   * records the call and says whose it was.
   */
  it("should record the receiver a response builder was called on", () => {
    const record = scannedRecord(
      "export default function proxy() { return NextResponse.json({}); }",
    );
    expect(record.bodyReads).toEqual([{ receiver: "NextResponse", method: "json" }]);
  });

  it("should record nothing for a call on something that is not a bare identifier", () => {
    expect(scannedRecord("export const a = () => ctx.req.json();").bodyReads).toEqual([]);
  });

  it("should record nothing for a method that consumes no body", () => {
    expect(scannedRecord("export const a = () => request.headers();").bodyReads).toEqual([]);
  });
});

describe("the readings the product abstentions argue from", () => {
  it("should record a chain written on a browser global, and drop the window prefix", () => {
    const record = scannedRecord("export const go = () => { window.location.href = '/a'; };");
    expect(record.globalAccess).toContainEqual({ path: "location.href", assigned: true });
  });

  it("should record the same chain written without the prefix as one fact", () => {
    const record = scannedRecord("export const p = () => location.pathname;");
    expect(record.globalAccess).toContainEqual({ path: "location.pathname", assigned: false });
  });

  it("should tell a read from a write", () => {
    const record = scannedRecord("export const p = () => history.pushState({}, '', '/a');");
    expect(record.globalAccess).toContainEqual({ path: "history.pushState", assigned: false });
  });

  it("should record nothing for a chain rooted in the project's own object", () => {
    const record = scannedRecord("export const p = (theme) => theme.location.pathname;");
    expect(record.globalAccess).toEqual([]);
  });

  /**
   * A file writing its own `location` is reading its own object. Reporting it would name a
   * hand-rolled equivalent in a file that has none, so the whole root is dropped for that file.
   */
  it.each([
    [
      "a local const",
      "export const p = () => { const location = { pathname: '/a' }; return location.pathname; };",
    ],
    ["a parameter", "export const p = (location) => location.pathname;"],
    ["an import", "import { location } from './l.js';\nexport const p = () => location.pathname;"],
  ])("should record nothing where %s shadows the global", (_label, code) => {
    expect(scannedRecord(code).globalAccess).toEqual([]);
  });

  it("should count a catch clause", () => {
    const record = scannedRecord("export const f = () => { try { g(); } catch (e) { h(e); } };");
    expect(record.catchClauses).toBe(1);
  });

  /**
   * Locally declared, because that declaration is what says the dropped value is a promise. A call
   * to an imported name may return anything, and reporting one would be a guess about another file.
   */
  it("should record a call to a local async function left unawaited", () => {
    const record = scannedRecord(
      ["async function log() {}", "export function f() { log(); return 1; }"].join("\n"),
    );
    expect(record.unawaitedLocalAsyncCalls).toEqual(["log"]);
  });

  it("should record nothing where the same call is awaited", () => {
    const record = scannedRecord(
      ["async function log() {}", "export async function f() { await log(); }"].join("\n"),
    );
    expect(record.unawaitedLocalAsyncCalls).toEqual([]);
  });

  it("should record nothing for a bare call to an imported name", () => {
    const record = scannedRecord(
      ["import { log } from './l.js';", "export function f() { log(); }"].join("\n"),
    );
    expect(record.unawaitedLocalAsyncCalls).toEqual([]);
  });

  it("should record the name a get call asks for, lower-cased", () => {
    const record = scannedRecord("export const f = (h) => h.get('User-Agent');");
    expect(record.getArguments).toEqual(["user-agent"]);
  });

  it.each([
    ["a regular-expression literal", "export const bot = /bot/i;"],
    ["a test call", "export const f = (r, v) => r.test(v);"],
    ["an includes call", "export const f = (v) => v.includes('bot');"],
  ])("should record %s as matching a value", (_label, code) => {
    expect(scannedRecord(code).matchesAValue).toBe(true);
  });

  it("should record a URL built from a request's url", () => {
    const record = scannedRecord("export const f = (request) => new URL(request.url);");
    expect(record.parsesRequestUrl).toBe(true);
  });

  it("should record nothing for a URL built from a literal", () => {
    expect(scannedRecord("export const u = new URL('/a', 'http://x');").parsesRequestUrl).toBe(
      false,
    );
  });

  it("should count a Response built from a stringified body", () => {
    const record = scannedRecord("export const f = () => new Response(JSON.stringify({ a: 1 }));");
    expect(record.jsonResponses).toBe(1);
  });

  it("should record the status a response is built with", () => {
    const record = scannedRecord("export const r = () => new Response(null, { status: 307 });");
    expect(record.statusValues).toEqual([307]);
  });

  it("should record the status a redirect helper names", () => {
    const record = scannedRecord("export const r = () => Response.redirect('/a', 308);");
    expect(record.statusValues).toEqual([308]);
  });

  /**
   * `status` belongs to a domain object as often as to a response. A page holding one for an order
   * was reported as answering a missing record by hand until this was narrowed.
   */
  it.each([
    ["a domain object", "export const shipment = { status: 404 };"],
    ["a variable", "export const r = () => new Response(null, { status: code });"],
    ["something else built the same way", "export const r = () => new Headers({ status: 307 });"],
  ])("should record nothing for %s", (_label, code) => {
    expect(scannedRecord(code).statusValues).toEqual([]);
  });

  it("should record a read off searchParams", () => {
    expect(
      scannedRecord("export const f = (searchParams) => searchParams.q;").readsSearchParams,
    ).toBe(true);
  });
});

describe("a route prop read off the binding rather than off the name", () => {
  /** The flags for one file, which is the unit both readings are per. */
  function flags(source: string) {
    const root = syntheticProject({ "app/page.tsx": source });
    const file = scanSources(root).files.find((one) => one.path.endsWith("page.tsx"));
    if (file === undefined) throw new Error("the scan found no file");
    return { params: file.readsRouteParams, searchParams: file.readsSearchParams };
  }

  it.each([
    ["a destructured parameter", "export default function Page({ params }) { return params.id; }"],
    ["a plain parameter", "export default function Page(params) { return params.id; }"],
    [
      "a local bound to an await",
      "export default async function Page(props) {\n  const params = await props.params;\n  return params.id;\n}",
    ],
    [
      "a name destructured out of an await",
      "export default async function Page(props) {\n  const { params } = await props;\n  return params.id;\n}",
    ],
  ])("should read %s as the route's own", (_name, source) => {
    expect(flags(source).params).toBe(true);
  });

  /**
   * The defect. `URLSearchParams` in a variable called `params` is ordinary JavaScript, and a real
   * starter's query-string builder was reported through a three-file import chain as a client
   * component reading a route parameter.
   */
  it("should not read a URLSearchParams local as the route's own", () => {
    const source = [
      "export function getPosts(query) {",
      "  const params = new URLSearchParams();",
      "  params.append('query', query);",
      "  return params.toString();",
      "}",
    ].join("\n");
    expect(flags(source).params).toBe(false);
  });

  it.each([
    ["a call", "const params = buildParams();\nexport const q = params.toString();"],
    ["an object literal", "const params = { id: '1' };\nexport const q = params.id;"],
    ["an import", "import { params } from './elsewhere';\nexport const q = params.id;"],
  ])("should not read a local bound to %s as the route's own", (_name, source) => {
    expect(flags(source).params).toBe(false);
  });

  it("should apply the same reading to searchParams", () => {
    const local =
      "const searchParams = new URLSearchParams();\nexport const q = searchParams.get('a');";
    expect(flags(local).searchParams).toBe(false);
    const prop = "export default function Page({ searchParams }) { return searchParams.q; }";
    expect(flags(prop).searchParams).toBe(true);
  });

  /**
   * The accepted cost, and it is the direction this scan errs in everywhere else: a file that both
   * receives the prop and binds an unrelated local of the same name reports nothing, exactly as a
   * file shadowing a browser root drops that root for the whole file.
   */
  it("should drop the name for the whole file where one binding disqualifies it", () => {
    const source = [
      "export default function Page({ params }) {",
      "  return params.id;",
      "}",
      "export function query(term) {",
      "  const params = new URLSearchParams();",
      "  params.append('q', term);",
      "  return params.toString();",
      "}",
    ].join("\n");
    expect(flags(source).params).toBe(false);
  });
});

describe("the workspace members a project links to", () => {
  /**
   * A monorepo with three members: a library the app depends on, a sibling Next app it does not,
   * and the app itself. Built with the `node_modules` symlink a package manager would create, so
   * the resolver meets the same shape it meets in a real workspace.
   */
  function workspace() {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-links-"));
    const write = (relative: string, contents: string) => {
      const full = join(root, relative);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    };
    write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    write("package.json", JSON.stringify({ name: "root", private: true }));
    write(
      "packages/db/package.json",
      JSON.stringify({ name: "@acme/db", version: "1.0.0", main: "src/index.ts" }),
    );
    write(
      "packages/db/src/index.ts",
      "import { cookies } from 'next/headers'\nexport const session = () => cookies()\n",
    );
    write(
      "apps/admin/package.json",
      JSON.stringify({
        name: "admin",
        dependencies: { next: "16.3.0", "@acme/db": "workspace:*" },
      }),
    );
    write(
      "apps/admin/app/page.tsx",
      "import { session } from '@acme/db'\nexport default session\n",
    );
    // The sibling declares `next` and the app does not depend on it: the old reading kept it.
    write(
      "apps/donor/package.json",
      JSON.stringify({ name: "donor", dependencies: { next: "16.3.0" } }),
    );
    write("apps/donor/app/page.tsx", "export default function P() { return null }\n");
    mkdirSync(join(root, "apps", "admin", "node_modules", "@acme"), { recursive: true });
    symlinkSync(
      join(root, "packages", "db"),
      join(root, "apps", "admin", "node_modules", "@acme", "db"),
    );
    return { root, app: join(root, "apps", "admin") };
  }

  it("should retain a library the app depends on", () => {
    const { root, app } = workspace();
    expect([...linkedPackages(app)]).toEqual([join(root, "packages", "db")]);
  });

  /**
   * The misattribution the old reading made. It kept any member declaring `next` and dropped every
   * other, so a sibling app the project has nothing to do with was scanned as part of it.
   */
  it("should not retain a next-declaring sibling the app does not depend on", () => {
    const { root, app } = workspace();
    expect([...linkedPackages(app)]).not.toContain(join(root, "apps", "donor"));
  });

  it("should retain nothing for a project outside any workspace", () => {
    const alone = mkdtempSync(join(tmpdir(), "next-coverage-alone-"));
    writeFileSync(join(alone, "package.json"), JSON.stringify({ name: "solo" }));
    expect(linkedPackages(alone).size).toBe(0);
  });

  it("should walk a retained package's own files and leave the sibling's alone", () => {
    const { root, app } = workspace();
    const files = findSourceFiles(app);
    expect(files).toContain(join(root, "packages", "db", "src", "index.ts"));
    expect(files.some((path) => path.includes(join("apps", "donor")))).toBe(false);
  });

  /**
   * A linked package resolves through a `node_modules` symlink, so every test that decides a
   * specifier is external answers yes about it. It is this repository's own code, and the scan has
   * to read it as such — which is what made `cookies()` in a linked package read as unused.
   */
  it("should resolve a specifier into a linked package as internal", () => {
    const { root, app } = workspace();
    const index = scanSources(app);
    const page = index.byPath.get(join(app, "app", "page.tsx"));
    const reference = page?.moduleReferences.find((one) => one.specifier === "@acme/db");
    expect(reference?.resolution).toEqual({
      kind: "internal",
      path: realpathSync(join(root, "packages", "db", "src", "index.ts")),
    });
  });

  it("should carry the linked package's own file into the scan", () => {
    const { root, app } = workspace();
    const index = scanSources(app);
    expect(index.byPath.has(join(root, "packages", "db", "src", "index.ts"))).toBe(true);
  });
});

describe("the manifest an absent import from a linked package answers to", () => {
  /**
   * A monorepo where the app links a library the app itself declares no other dependency of. The
   * library imports a package that only its own manifest names, never the app's — the shape the
   * survey found: `apps/www` never declares `@base-ui/react`, `packages/ui` does, and the import
   * sits in `packages/ui/src/Tabs/Tabs.tsx`.
   */
  function workspaceWithLinkedDependency() {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-link-manifest-"));
    const write = (relative: string, contents: string) => {
      const full = join(root, relative);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    };
    write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    write("package.json", JSON.stringify({ name: "root", private: true }));
    write(
      "packages/ui/package.json",
      JSON.stringify({
        name: "@acme/ui",
        version: "1.0.0",
        main: "src/index.ts",
        dependencies: { "left-pad": "^1.0.0" },
      }),
    );
    write("packages/ui/src/index.ts", "import { pad } from 'left-pad'\nexport const x = pad\n");
    write(
      "apps/www/package.json",
      JSON.stringify({
        name: "www",
        dependencies: { next: "16.3.0", "@acme/ui": "workspace:*" },
      }),
    );
    write("apps/www/app/page.tsx", "export default function P() { return null }\n");
    return join(root, "apps", "www");
  }

  // The app's own manifest never mentions `left-pad`, and the old reading checked only that
  // manifest for every specifier the scan walked into — reporting a dependency the linked package
  // declares as one the whole project lacks.
  it("should read `declared: yes` for a package the linked package's own manifest names", () => {
    const app = workspaceWithLinkedDependency();
    const { resolution } = scanSources(app);
    expect(resolution.missingPackages).toEqual([
      { name: "left-pad", declared: "yes", references: 1 },
    ]);
  });
});

describe("the vendored workspace fixture", () => {
  const ROOT = WORKSPACE_FIXTURE;
  const app = join(ROOT, "apps", "panel");

  /**
   * The shape the survey found: a request API called from a linked package and from nowhere else.
   * Before the workspace walk the file was never opened and the entry read as unused.
   */
  it("should read the linked package's own file and not the sibling's", () => {
    const index = scanSources(app);
    const relative = index.files.map((file) => file.path.slice(ROOT.length + 1)).sort();
    expect(relative).toEqual([
      join("apps", "panel", "app", "layout.tsx"),
      join("apps", "panel", "app", "page.tsx"),
      join("packages", "datos", "src", "index.ts"),
    ]);
  });

  it("should count the linked package it read", () => {
    expect(scanSources(app).linked).toEqual({ scanned: 1, unmatched: 0 });
  });

  it("should resolve the linked specifier as this project's own code", () => {
    const index = scanSources(app);
    const page = index.byPath.get(join(app, "app", "page.tsx"));
    const reference = page?.moduleReferences.find((one) => one.specifier === "@vendored/datos");
    expect(reference?.resolution.kind).toBe("internal");
  });
});
