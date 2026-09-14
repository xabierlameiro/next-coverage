import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureContext } from "../../test-support/corpus.js";
import { DEFAULT_PAGE_EXTENSIONS, resolved, unresolved } from "../types.js";
import { readFlagList, readNextConfig } from "./config.js";
import { buildLedger, type Ledger } from "./ledger.js";
import type { Bundler } from "./project.js";
import { discoverProject, type ProjectContext } from "./project.js";
import { buildRouteTree, type RouteTree } from "./routes.js";
import { scanSources } from "./sources.js";

function ledgerOf(files: Record<string, string>): Ledger {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-ledger-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const appDirectory = join(root, "app");
  mkdirSync(appDirectory, { recursive: true });
  const tree: RouteTree = buildRouteTree({
    appDirectory,
    pageExtensions: DEFAULT_PAGE_EXTENSIONS,
    isFlagEnabled: () => true,
  });
  // No manifest and no config: the package cross-check has nothing to say about these, which
  // keeps these cases about cache tags alone.
  const project: ProjectContext = {
    root,
    appDirectory: { path: appDirectory },
    installedNext: undefined,
    version: resolved("16.3.0"),
    config: undefined,
    declaredPackages: unresolved("no manifest in this synthetic project"),
    bundlers: resolved(new Set<Bundler>(["turbopack"])),
    typeScriptMajor: unresolved("no installed typescript in this fixture"),
    pageExtensions: resolved(DEFAULT_PAGE_EXTENSIONS),
  };
  return buildLedger(scanSources(root), tree, project);
}

const values = (declarations: Ledger["orphanTags"]) => declarations.map((d) => d.value);

const PRODUCE = "import { cacheTag } from 'next/cache'\nexport const a = () => cacheTag('x')\n";
const CONSUME =
  "import { revalidateTag } from 'next/cache'\nexport const b = () => revalidateTag('x')\n";

describe("tag matching", () => {
  it("should report a tag nothing invalidates", () => {
    expect(values(ledgerOf({ "app/a.ts": PRODUCE }).orphanTags)).toEqual(["x"]);
  });

  it("should report an invalidation of a tag nothing produces", () => {
    expect(values(ledgerOf({ "app/b.ts": CONSUME }).phantomTags)).toEqual(["x"]);
  });

  it("should report nothing when both sides exist in different files", () => {
    const ledger = ledgerOf({ "app/a.ts": PRODUCE, "app/b.ts": CONSUME });
    expect(ledger.orphanTags).toEqual([]);
    expect(ledger.phantomTags).toEqual([]);
  });

  it("should accept updateTag as an invalidation", () => {
    const ledger = ledgerOf({
      "app/a.ts": PRODUCE,
      "app/b.ts": "import { updateTag } from 'next/cache'\nexport const b = () => updateTag('x')\n",
    });
    expect(ledger.orphanTags).toEqual([]);
  });

  it("should treat a tagged fetch as producing the tag", () => {
    const ledger = ledgerOf({
      "app/a.ts": "export const a = () => fetch('/x', { next: { tags: ['x'] } })\n",
      "app/b.ts": CONSUME,
    });
    expect(ledger.phantomTags).toEqual([]);
    expect(ledger.orphanTags).toEqual([]);
  });

  it("should treat the deprecated cache helper's tags as producing them", () => {
    const ledger = ledgerOf({
      "app/a.ts":
        "import { unstable_cache } from 'next/cache'\nexport const a = unstable_cache(f, ['k'], { tags: ['x'] })\n",
      "app/b.ts": CONSUME,
    });
    expect(ledger.phantomTags).toEqual([]);
    expect(ledger.orphanTags).toEqual([]);
  });

  it("should report a tag the deprecated helper produces and nothing invalidates", () => {
    const ledger = ledgerOf({
      "app/a.ts":
        "import { unstable_cache } from 'next/cache'\nexport const a = unstable_cache(f, ['k'], { tags: ['x'] })\n",
    });
    expect(values(ledger.orphanTags)).toEqual(["x"]);
  });

  it("should count nothing for a helper call that carries no options", () => {
    const ledger = ledgerOf({
      "app/a.ts":
        "import { unstable_cache } from 'next/cache'\nexport const a = unstable_cache(f, ['k'])\n",
    });
    expect(ledger.unresolved).toBe(0);
    expect(ledger.orphanTags).toEqual([]);
  });

  it("should follow an aliased import", () => {
    const ledger = ledgerOf({
      "app/a.ts": "import { cacheTag as tag } from 'next/cache'\nexport const a = () => tag('x')\n",
      "app/b.ts": CONSUME,
    });
    expect(ledger.orphanTags).toEqual([]);
  });

  /**
   * `next/cache` re-exports cacheTag from `next/dist/server/use-cache/cache-tag`, and real
   * projects import the inner path — aurorascharff/next16-commerce tags four components that
   * way. Reading only the documented spelling reported the tag as invalidated by nobody, which
   * states something false about the project rather than reading less of it.
   */
  it("should count a tag produced through the path next/cache re-exports from", () => {
    const ledger = ledgerOf({
      "app/hero.tsx":
        "import { cacheTag } from 'next/dist/server/use-cache/cache-tag'\nexport const h = () => cacheTag('featured')\n",
      "app/a.ts":
        "import { revalidateTag } from 'next/cache'\nexport const a = () => revalidateTag('featured')\n",
    });
    expect(values(ledger.phantomTags)).not.toContain("featured");
    expect(values(ledger.orphanTags)).not.toContain("featured");
  });

  it("should ignore a project's own function of the same name", () => {
    const ledger = ledgerOf({
      "app/a.ts": PRODUCE,
      "app/b.ts":
        "import { revalidateTag } from './mine'\nexport const b = () => revalidateTag('x')\n",
    });
    expect(values(ledger.orphanTags)).toEqual(["x"]);
  });

  it("should name the file each declaration came from", () => {
    const ledger = ledgerOf({ "app/a.ts": PRODUCE });
    expect(ledger.orphanTags[0]?.files[0]).toContain("a.ts");
  });
});

describe("unresolved values", () => {
  it("should exclude a computed tag from both sides and count it", () => {
    const ledger = ledgerOf({
      "app/a.ts": "import { cacheTag } from 'next/cache'\nexport const a = (t) => cacheTag(t)\n",
    });
    expect(ledger.orphanTags).toEqual([]);
    expect(ledger.unresolved).toBe(1);
  });

  it("should never let a computed value make a real tag look unmatched", () => {
    const ledger = ledgerOf({
      "app/a.ts": PRODUCE,
      "app/b.ts":
        "import { revalidateTag } from 'next/cache'\nexport const b = (t) => revalidateTag(t)\n",
    });
    // The literal tag is still orphaned, and the computed one adds nothing either way.
    expect(values(ledger.orphanTags)).toEqual(["x"]);
    expect(ledger.unresolved).toBe(1);
  });
});

describe("path matching", () => {
  const page = "export default function P() { return null }\n";

  it("should accept a concrete path a dynamic route would serve", () => {
    const ledger = ledgerOf({
      "app/[lang]/dashboard/page.tsx": page,
      "app/a.ts":
        "import { revalidatePath } from 'next/cache'\nexport const a = () => revalidatePath('/en/dashboard')\n",
    });
    expect(ledger.unmatchedPaths).toEqual([]);
  });

  it("should report a concrete path no route serves", () => {
    const ledger = ledgerOf({
      "app/[lang]/dashboard/page.tsx": page,
      "app/a.ts":
        "import { revalidatePath } from 'next/cache'\nexport const a = () => revalidatePath('/dashboard')\n",
    });
    expect(values(ledger.unmatchedPaths)).toEqual(["/dashboard"]);
  });

  it("should accept a route pattern that exists", () => {
    const ledger = ledgerOf({
      "app/[lang]/dashboard/page.tsx": page,
      "app/a.ts":
        "import { revalidatePath } from 'next/cache'\nexport const a = () => revalidatePath('/[lang]/dashboard')\n",
    });
    expect(ledger.unmatchedPaths).toEqual([]);
  });

  it("should report a route pattern that does not exist", () => {
    const ledger = ledgerOf({
      "app/[lang]/dashboard/page.tsx": page,
      "app/a.ts":
        "import { revalidatePath } from 'next/cache'\nexport const a = () => revalidatePath('/[lang]/missing')\n",
    });
    expect(values(ledger.unmatchedPaths)).toEqual(["/[lang]/missing"]);
  });

  it("should accept a path a catch-all would serve", () => {
    const ledger = ledgerOf({
      "app/docs/[...slug]/page.tsx": page,
      "app/a.ts":
        "import { revalidatePath } from 'next/cache'\nexport const a = () => revalidatePath('/docs/a/b/c')\n",
    });
    expect(ledger.unmatchedPaths).toEqual([]);
  });
});

describe("packages a config list names but the manifest does not declare", () => {
  function projectWith(manifest: string | undefined, config: string) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-pkg-"));
    mkdirSync(join(root, "app"), { recursive: true });
    if (manifest !== undefined) writeFileSync(join(root, "package.json"), manifest);
    writeFileSync(join(root, "next.config.ts"), config);
    const discovery = discoverProject(root);
    if (discovery.kind !== "ok") throw new Error("expected discovery to succeed");
    const tree = buildRouteTree({
      appDirectory: join(root, "app"),
      pageExtensions: DEFAULT_PAGE_EXTENSIONS,
      isFlagEnabled: () => true,
    });
    return buildLedger(scanSources(root), tree, discovery.project);
  }

  const MANIFEST = '{"name":"x","dependencies":{"next":"16.3.0","pg":"1.0.0"}}';
  const ENTRY = "config/next-config-js/serverExternalPackages";

  it("should report a package the project does not depend on", () => {
    const ledger = projectWith(MANIFEST, "export default { serverExternalPackages: ['nope'] };");
    expect(values(ledger.undeclaredPackages.get(ENTRY) ?? [])).toEqual(["nope"]);
  });

  it("should say nothing about a package the manifest declares", () => {
    // Declared and imported nowhere is not a finding: a transitive dependency can be listed on
    // purpose, because these options are about the bundler, not the import graph.
    const ledger = projectWith(MANIFEST, "export default { serverExternalPackages: ['pg'] };");
    expect(ledger.undeclaredPackages.get(ENTRY)).toBeUndefined();
  });

  it("should find them under the experimental spelling too", () => {
    const ledger = projectWith(
      MANIFEST,
      "export default { experimental: { optimizePackageImports: ['nope'] } };",
    );
    const found = ledger.undeclaredPackages.get("config/next-config-js/optimizePackageImports");
    expect(values(found ?? [])).toEqual(["nope"]);
  });

  it("should report nothing when the manifest could not be read", () => {
    // Built directly rather than through discovery: without a manifest there is no project to
    // discover, so this branch only exists for a manifest that is present and unreadable.
    const root = mkdtempSync(join(tmpdir(), "next-coverage-nomanifest-"));
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "next.config.ts"), "export default { transpilePackages: ['nope'] };");
    const tree = buildRouteTree({
      appDirectory: join(root, "app"),
      pageExtensions: DEFAULT_PAGE_EXTENSIONS,
      isFlagEnabled: () => true,
    });
    const project: ProjectContext = {
      root,
      appDirectory: { path: join(root, "app") },
      installedNext: undefined,
      version: resolved("16.3.0"),
      config: readNextConfig(root),
      declaredPackages: unresolved("the project manifest could not be read"),
      bundlers: resolved(new Set<Bundler>(["turbopack"])),
      typeScriptMajor: unresolved("no installed typescript in this fixture"),
      pageExtensions: resolved(DEFAULT_PAGE_EXTENSIONS),
    };
    // The list is readable and names an undeclared package; only the unresolved manifest keeps
    // it quiet, which is the point: an unreadable manifest cannot show anything to be missing.
    expect(readFlagList(project.config, "transpilePackages").status).toBe("resolved");
    expect(buildLedger(scanSources(root), tree, project).undeclaredPackages.size).toBe(0);
  });

  it("should count what it could not read rather than judging it", () => {
    const ledger = projectWith(
      MANIFEST,
      "export default { serverExternalPackages: ['nope', COMPUTED] };",
    );
    expect(values(ledger.undeclaredPackages.get(ENTRY) ?? [])).toEqual(["nope"]);
    expect(ledger.unresolved).toBeGreaterThan(0);
  });
});

describe("the vendored fixture that tags through the deprecated helper", () => {
  it("should report the tag its options name and nothing invalidates", () => {
    const context = fixtureContext("incomplete-app");
    const ledger = buildLedger(context.sources, context.tree, context.project);
    // Read only through the options argument: without that reading the tag exists in the project
    // and the ledger sees nothing at all.
    expect(values(ledger.orphanTags)).toContain("heredado-sin-invalidar");
  });
});
