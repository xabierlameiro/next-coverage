import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReexportOnly, readDependencyManifest, resolveDependency } from "./packages.js";

function projectWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-pkg-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function dependency(
  name: string,
  manifest: Record<string, unknown>,
  entry?: string,
  entryPath = "index.js",
): Record<string, string> {
  const files: Record<string, string> = {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, version: "1.0.0", ...manifest }),
  };
  if (entry !== undefined) files[`node_modules/${name}/${entryPath}`] = entry;
  return files;
}

describe("resolving a declared dependency's installed root", () => {
  it("should resolve a package installed under the project", () => {
    const root = projectWith(dependency("motor", { main: "./index.js" }, "module.exports = {};"));
    const found = resolveDependency(root, "motor");
    expect(found.status).toBe("resolved");
    if (found.status !== "resolved") return;
    expect(found.value).toBe(join(root, "node_modules", "motor"));
  });

  it("should resolve a scoped package", () => {
    const root = projectWith(
      dependency("@ambito/motor", { main: "./index.js" }, "module.exports = {};"),
    );
    expect(resolveDependency(root, "@ambito/motor").status).toBe("resolved");
  });

  it("should decline a specifier that resolves nowhere", () => {
    const root = projectWith({});
    const found = resolveDependency(root, "motor");
    expect(found.status).toBe("unresolved");
    if (found.status !== "unresolved") return;
    expect(found.reason).toContain("not installed");
  });

  /**
   * The framework resolver climbs to the filesystem root, which is right for `next`. This one must
   * not: a package three directories above the project belongs to somebody else's tree, and the
   * question here is what the analysed project bundles.
   */
  it("should not climb above the project root", () => {
    const outer = projectWith(dependency("motor", { main: "./index.js" }, "module.exports = {};"));
    const inner = join(outer, "paquetes", "app");
    mkdirSync(inner, { recursive: true });
    expect(resolveDependency(inner, "motor").status).toBe("unresolved");
  });

  it.each(["../otro", "./local", "/absoluto", "motor/../../otro"])(
    "should decline '%s' rather than following it",
    (specifier) => {
      const root = projectWith({});
      const found = resolveDependency(root, specifier);
      expect(found.status).toBe("unresolved");
      if (found.status !== "unresolved") return;
      expect(found.reason).toContain("bare package specifier");
    },
  );
});

describe("reading an installed dependency's own manifest", () => {
  const manifestOf = (files: Record<string, string>, name: string) => {
    const root = projectWith(files);
    return readDependencyManifest(join(root, "node_modules", name));
  };

  it("should report a declared native addon and the entry main names", () => {
    const found = manifestOf(
      dependency(
        "motor",
        { gypfile: true, main: "./lib/entrada.js" },
        "module.exports = {};",
        "lib/entrada.js",
      ),
      "motor",
    );
    expect(found.status).toBe("resolved");
    if (found.status !== "resolved") return;
    expect(found.value.gypfile).toBe(true);
    expect(found.value.entry.endsWith(join("lib", "entrada.js"))).toBe(true);
  });

  it("should prefer the root condition of exports over main", () => {
    const found = manifestOf(
      dependency(
        "motor",
        { main: "./cjs.js", exports: { ".": { import: "./esm.js", require: "./cjs.js" } } },
        "export {};",
        "esm.js",
      ),
      "motor",
    );
    expect(found.status).toBe("resolved");
    if (found.status !== "resolved") return;
    expect(found.value.entry.endsWith("esm.js")).toBe(true);
  });

  it("should report no native addon where the manifest declares none", () => {
    const found = manifestOf(dependency("motor", { main: "./index.js" }, "export {};"), "motor");
    expect(found.status).toBe("resolved");
    if (found.status !== "resolved") return;
    expect(found.value.gypfile).toBe(false);
  });

  it("should decline a manifest naming no entry through exports or main", () => {
    const found = manifestOf(dependency("motor", {}), "motor");
    expect(found.status).toBe("unresolved");
    if (found.status !== "unresolved") return;
    expect(found.reason).toContain("names no entry module");
  });

  /**
   * A conditional map naming a different file per runtime states more than one entry, and picking
   * one of them would report on a module the project may never load.
   */
  it("should decline an exports map whose root names no string", () => {
    const found = manifestOf(dependency("motor", { exports: { ".": { types: {} } } }), "motor");
    expect(found.status).toBe("unresolved");
  });

  it("should decline an entry pointing outside its own package", () => {
    const found = manifestOf(dependency("motor", { main: "../../fuera.js" }), "motor");
    expect(found.status).toBe("unresolved");
    if (found.status !== "unresolved") return;
    expect(found.reason).toContain("outside its own package");
  });

  it("should decline a manifest that will not parse", () => {
    const root = projectWith({ "node_modules/motor/package.json": "{ no es json" });
    expect(readDependencyManifest(join(root, "node_modules", "motor")).status).toBe("unresolved");
  });
});

describe("reading whether an entry module is a re-export barrel", () => {
  const entryAt = (contents: string) => {
    const root = projectWith({ "node_modules/barril/index.js": contents });
    return isReexportOnly(join(root, "node_modules", "barril", "index.js"));
  };

  it("should report a module that is nothing but re-exports", () => {
    const found = entryAt(
      ["export * from './uno.js';", "export { dos } from './dos.js';"].join("\n"),
    );
    expect(found).toEqual({ status: "resolved", value: true });
  });

  it("should not report a module that declares anything of its own", () => {
    const found = entryAt(
      ["export * from './uno.js';", "export function dos() { return 2; }"].join("\n"),
    );
    expect(found).toEqual({ status: "resolved", value: false });
  });

  /** A re-export naming no module is a local re-export, which reaches nothing to be optimised. */
  it("should not report a module whose exports name no other module", () => {
    const found = entryAt(["const uno = 1;", "export { uno };"].join("\n"));
    expect(found).toEqual({ status: "resolved", value: false });
  });

  /**
   * An empty file re-exports nothing, and reporting one would name a package for holding nothing
   * at all — which is the opposite of the shape the option is for.
   */
  it("should not report an empty module as a barrel", () => {
    expect(entryAt("")).toEqual({ status: "resolved", value: false });
  });

  it("should decline a file that is not there", () => {
    const root = projectWith({});
    const found = isReexportOnly(join(root, "node_modules", "barril", "index.js"));
    expect(found.status).toBe("unresolved");
    if (found.status !== "unresolved") return;
    expect(found.reason).toContain("could not be read");
  });
});
