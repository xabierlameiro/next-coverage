import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilerOptionsOf, createResolver } from "./resolve.js";

function syntheticProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-resolve-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    moduleResolution: "bundler",
    paths: {
      "@/*": ["./app/*"],
      "@/env": ["./app/lib/env.ts"],
    },
  },
});

describe("specifier resolution", () => {
  it("should resolve a relative specifier written without an extension", () => {
    const root = syntheticProject({
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "import { x } from './helper'\n",
      "app/helper.ts": "export const x = 1\n",
    });
    const resolve = createResolver(root);
    expect(resolve("./helper", join(root, "app/page.tsx"))).toEqual({
      kind: "internal",
      path: join(root, "app/helper.ts"),
    });
  });

  it("should resolve a path alias, because most internal edges are written that way", () => {
    const root = syntheticProject({
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "import { env } from '@/lib/env'\n",
      "app/lib/env.ts": "export const env = {}\n",
    });
    const resolve = createResolver(root);
    expect(resolve("@/lib/env", join(root, "app/page.tsx"))).toEqual({
      kind: "internal",
      path: join(root, "app/lib/env.ts"),
    });
  });

  it("should resolve an alias declared without a wildcard", () => {
    const root = syntheticProject({
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "import { env } from '@/env'\n",
      "app/lib/env.ts": "export const env = {}\n",
    });
    const resolve = createResolver(root);
    expect(resolve("@/env", join(root, "app/page.tsx"))).toEqual({
      kind: "internal",
      path: join(root, "app/lib/env.ts"),
    });
  });

  it("should resolve a directory to its index module", () => {
    const root = syntheticProject({
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "import { x } from '@/utils'\n",
      "app/utils/index.ts": "export const x = 1\n",
    });
    const resolve = createResolver(root);
    expect(resolve("@/utils", join(root, "app/page.tsx"))).toEqual({
      kind: "internal",
      path: join(root, "app/utils/index.ts"),
    });
  });

  it("should call a dependency external", () => {
    const root = syntheticProject({
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "import { x } from 'dep'\n",
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", main: "index.js" }),
      "node_modules/dep/index.ts": "export const x = 1\n",
    });
    const resolve = createResolver(root);
    expect(resolve("dep", join(root, "app/page.tsx"))).toEqual({ kind: "external" });
  });

  it("should call a declaration file external, because it carries no runtime code", () => {
    const root = syntheticProject({
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "import type { X } from '@/types'\n",
      "app/types.d.ts": "export type X = string\n",
    });
    const resolve = createResolver(root);
    expect(resolve("@/types", join(root, "app/page.tsx"))).toEqual({ kind: "external" });
  });

  it("should report a specifier that resolves nowhere, without inventing a path", () => {
    const root = syntheticProject({
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "import { x } from './missing'\n",
    });
    const resolve = createResolver(root);
    expect(resolve("./missing", join(root, "app/page.tsx"))).toEqual({ kind: "unresolved" });
  });

  it("should resolve relative specifiers and give up on aliases when there is no tsconfig", () => {
    const root = syntheticProject({
      "app/page.tsx": "import { x } from './helper'\n",
      "app/helper.ts": "export const x = 1\n",
    });
    const resolve = createResolver(root);
    expect(resolve("./helper", join(root, "app/page.tsx"))).toEqual({
      kind: "internal",
      path: join(root, "app/helper.ts"),
    });
    expect(resolve("@/helper", join(root, "app/page.tsx"))).toEqual({ kind: "unresolved" });
  });

  it("should survive a tsconfig it cannot read", () => {
    const root = syntheticProject({
      "tsconfig.json": "{ not json at all",
      "app/page.tsx": "import { x } from './helper'\n",
      "app/helper.ts": "export const x = 1\n",
    });
    expect(() => createResolver(root)).not.toThrow();
    expect(createResolver(root)("./helper", join(root, "app/page.tsx"))).toEqual({
      kind: "internal",
      path: join(root, "app/helper.ts"),
    });
  });
});

describe("compiler options", () => {
  it("should read the project's own paths", () => {
    const root = syntheticProject({ "tsconfig.json": TSCONFIG });
    expect(compilerOptionsOf(root).paths).toMatchObject({ "@/*": ["./app/*"] });
  });

  it("should not enumerate the project's files while reading its config", () => {
    const root = syntheticProject({
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "export default function P() { return null }\n",
    });
    // The options are what we need; walking the tree a second time would cost more than resolving.
    expect(compilerOptionsOf(root)).not.toHaveProperty("fileNames");
  });
});

describe("standard library specifiers", () => {
  const project = () =>
    syntheticProject({ "tsconfig.json": TSCONFIG, "app/page.tsx": "export default () => null\n" });

  it("should record a prefixed standard library module as external", () => {
    const root = project();
    const resolve = createResolver(root);
    for (const specifier of ["node:fs", "node:path", "node:child_process"]) {
      expect(resolve(specifier, join(root, "app/page.tsx"))).toEqual({ kind: "external" });
    }
  });

  it("should record a module that exists only under the prefix as external", () => {
    const root = project();
    const resolve = createResolver(root);
    for (const specifier of ["node:test", "node:test/reporters"]) {
      expect(resolve(specifier, join(root, "app/page.tsx"))).toEqual({ kind: "external" });
    }
    // Without the prefix, `test` is a package name like any other, not the runner.
    expect(resolve("test", join(root, "app/page.tsx"))).not.toEqual({ kind: "external" });
  });

  it("should record a bare standard library module as external, being the same module", () => {
    const root = project();
    const resolve = createResolver(root);
    expect(resolve("fs", join(root, "app/page.tsx"))).toEqual({ kind: "external" });
    expect(resolve("child_process", join(root, "app/page.tsx"))).toEqual({ kind: "external" });
  });

  it("should leave a project module sharing a standard library name resolving to that file", () => {
    const root = syntheticProject({
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "import { p } from './path'\n",
      "app/path.ts": "export const p = 1\n",
    });
    const resolve = createResolver(root);
    expect(resolve("./path", join(root, "app/page.tsx"))).toEqual({
      kind: "internal",
      path: join(root, "app/path.ts"),
    });
  });

  it("should leave a project module aliased over a standard library name resolving internally", () => {
    const root = syntheticProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { moduleResolution: "bundler", paths: { path: ["./app/path.ts"] } },
      }),
      "app/page.tsx": "import { p } from 'path'\n",
      "app/path.ts": "export const p = 1\n",
    });
    const resolve = createResolver(root);
    expect(resolve("path", join(root, "app/page.tsx"))).toEqual({
      kind: "internal",
      path: join(root, "app/path.ts"),
    });
  });

  it("should sort everything else by what its failure actually costs", () => {
    // Only the third can hide code the closure needed: the first is a dependency the project does
    // not have, and the second is a stylesheet. Counting all three as unresolved reported
    // blindness the scan did not have.
    const root = project();
    const resolve = createResolver(root);
    const from = join(root, "app/page.tsx");
    expect(resolve("@acme/never-installed", from).kind).toBe("missing-package");
    expect(resolve("../a.css", from)).toEqual({ kind: "asset" });
    expect(resolve("./typo-that-is-not-there", from)).toEqual({ kind: "unresolved" });
  });
});

describe("what a failed resolution actually is", () => {
  const root = () => syntheticProject({ "tsconfig.json": TSCONFIG, "app/page.tsx": "" });
  const from = (r: string) => join(r, "app/page.tsx");

  it.each([".css", ".scss", ".sass", ".less"])(
    "should record a %s import as an asset rather than an unresolved module",
    (extension) => {
      const r = root();
      expect(createResolver(r)(`./styles${extension}`, from(r))).toEqual({ kind: "asset" });
    },
  );

  it("should record a stylesheet reached through a package the same way", () => {
    const r = root();
    expect(createResolver(r)("maplibre-gl/dist/maplibre-gl.css", from(r))).toEqual({
      kind: "asset",
    });
  });

  it("should record a stylesheet carrying a bundler query suffix", () => {
    const r = root();
    expect(createResolver(r)("./a.css?inline", from(r))).toEqual({ kind: "asset" });
  });

  it("should name an absent package the manifest declares", () => {
    const r = root();
    const resolve = createResolver(r, undefined, new Set(["left-pad"]));
    expect(resolve("left-pad", from(r))).toEqual({
      kind: "missing-package",
      name: "left-pad",
      declared: "yes",
    });
  });

  it("should name an absent package the manifest never declares", () => {
    const r = root();
    const resolve = createResolver(r, undefined, new Set<string>());
    expect(resolve("@aws-appsync/utils", from(r))).toEqual({
      kind: "missing-package",
      name: "@aws-appsync/utils",
      declared: "no",
    });
  });

  it("should drop a subpath when naming the package", () => {
    const r = root();
    const resolve = createResolver(r, undefined, new Set<string>());
    const verdict = resolve("some-pkg/deep/thing.js", from(r));
    expect(verdict).toEqual({ kind: "missing-package", name: "some-pkg", declared: "no" });
  });

  it("should leave the declaration unknown when no manifest was read", () => {
    const r = root();
    expect(createResolver(r)("left-pad", from(r))).toEqual({
      kind: "missing-package",
      name: "left-pad",
      declared: "unknown",
    });
  });

  it("should keep a relative specifier naming no file as unresolved", () => {
    // The one case the figure exists for: this was meant to reach the project's own code, and
    // the walk stopped where it should have continued.
    const r = root();
    expect(createResolver(r)("./nowhere", from(r))).toEqual({ kind: "unresolved" });
  });

  it("should keep an alias naming no file as unresolved", () => {
    const r = root();
    expect(createResolver(r)("@/nowhere", from(r))).toEqual({ kind: "unresolved" });
  });
});
