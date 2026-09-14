import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, type Fixture, fixtureAvailable } from "../../test-support/fixtures.js";
import {
  readHtmlLimitedBots,
  readOptimizedImports,
  readOptionDefaults,
  readServerExternals,
  readTranspiled,
} from "./defaults.js";
import { type InstalledNext, resolveInstalledNext } from "./project.js";

const NOWHERE = "/nonexistent-package-path-for-this-test";

function installedOf(fixture: Fixture): InstalledNext {
  const installed = resolveInstalledNext(fixture.path);
  if (!installed) throw new Error(`expected an installed next for ${fixture.name}`);
  return installed;
}

const available = FIXTURES.filter(fixtureAvailable);

describe.skipIf(available.length === 0)(
  "the default lists ship inside the installed package",
  () => {
    // Tripwire for Vercel moving either list. A Next.js upgrade that relocates one must fail
    // here rather than silently stop producing findings.
    it.each(available)("should read both lists from $name", (fixture) => {
      const installed = installedOf(fixture);

      const optimized = readOptimizedImports(installed);
      expect(optimized.status).toBe("resolved");
      if (optimized.status !== "resolved") return;
      expect(optimized.value.size).toBeGreaterThanOrEqual(70);

      const externals = readServerExternals(installed);
      expect(externals.status).toBe("resolved");
      if (externals.status !== "resolved") return;
      expect(externals.value.size).toBeGreaterThanOrEqual(70);
    });

    // The specific members the conditions rest on. A release dropping one of these changes what
    // the tool reports about real projects, so it is asserted rather than assumed.
    it.each(available)("should carry the packages the conditions compare against on $name", (f) => {
      const installed = installedOf(f);
      const optimized = readOptimizedImports(installed);
      const externals = readServerExternals(installed);
      if (optimized.status !== "resolved" || externals.status !== "resolved") {
        throw new Error("expected both lists to resolve");
      }
      expect(optimized.value.has("lucide-react")).toBe(true);
      expect(optimized.value.has("recharts")).toBe(true);
      // The package that killed the native-binary condition: already external by default.
      expect(externals.value.has("sharp")).toBe(true);
    });
  },
);

describe("an unreadable list disables what rests on it", () => {
  it("should be unresolved when there is no installed package", () => {
    const optimized = readOptimizedImports(undefined);
    const externals = readServerExternals(undefined);
    expect(optimized.status).toBe("unresolved");
    expect(externals.status).toBe("unresolved");
    if (optimized.status !== "unresolved" || externals.status !== "unresolved") return;
    expect(optimized.reason).toContain("no installed next package");
    expect(externals.reason).toContain("no installed next package");
  });

  it("should be unresolved, naming the path, when the file is absent", () => {
    const missing: InstalledNext = { realPath: NOWHERE, linkPath: NOWHERE, version: "16.3.0" };
    const optimized = readOptimizedImports(missing);
    const externals = readServerExternals(missing);
    expect(optimized.status).toBe("unresolved");
    expect(externals.status).toBe("unresolved");
    if (optimized.status !== "unresolved" || externals.status !== "unresolved") return;
    expect(optimized.reason).toContain("config.js");
    expect(externals.reason).toContain("server-external-packages.jsonc");
    expect(optimized.reason).toContain("16.3.0");
  });
});

describe("the third list, which holds a single package", () => {
  it.each(available)("should read the default-transpiled list from $name", (fixture) => {
    const transpiled = readTranspiled(installedOf(fixture));
    expect(transpiled.status).toBe("resolved");
    if (transpiled.status !== "resolved") return;
    // One package today. The floor guarding the other two would reject it, so it has its own.
    expect(transpiled.value.has("geist")).toBe(true);
  });

  it("should be unresolved when there is no installed package", () => {
    expect(readTranspiled(undefined).status).toBe("unresolved");
  });

  it("should be unresolved, naming the path, when the file is absent", () => {
    const missing: InstalledNext = { realPath: NOWHERE, linkPath: NOWHERE, version: "16.3.0" };
    const transpiled = readTranspiled(missing);
    expect(transpiled.status).toBe("unresolved");
    if (transpiled.status !== "unresolved") return;
    expect(transpiled.reason).toContain("default-transpiled-packages.json");
  });

  /** A fake installed package whose third list holds exactly this text. */
  function withListContents(contents: string): InstalledNext {
    const realPath = mkdtempSync(join(tmpdir(), "next-coverage-fake-next-"));
    const dir = join(realPath, "dist", "lib");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default-transpiled-packages.json"), contents);
    return { realPath, linkPath: realPath, version: "16.3.0" };
  }

  it("should refuse contents that are not valid JSON", () => {
    const result = readTranspiled(withListContents("[geist"));
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") return;
    expect(result.reason).toContain("not valid JSON");
  });

  it("should refuse an object where an array of names belongs", () => {
    const result = readTranspiled(withListContents('{"geist":true}'));
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") return;
    expect(result.reason).toContain("not an array of names");
  });

  it("should refuse an array holding anything but strings", () => {
    const result = readTranspiled(withListContents('["geist", 3]'));
    expect(result.status).toBe("unresolved");
  });

  it("should refuse an empty list rather than read it as a claim", () => {
    // "Next.js transpiles nothing by default" is a statement this reader cannot make, and an
    // empty set would silently stop every comparison resting on it.
    const result = readTranspiled(withListContents("[]"));
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") return;
    expect(result.reason).toContain("empty");
  });

  it("should read a well-formed list", () => {
    const result = readTranspiled(withListContents('["geist", "other"]'));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect([...result.value]).toEqual(["geist", "other"]);
  });
});

describe("the scalar defaults the framework applies", () => {
  it.each(available)("should read them from $name", (fixture) => {
    const defaults = readOptionDefaults(installedOf(fixture));
    expect(defaults.status).toBe("resolved");
    if (defaults.status !== "resolved") return;
    // The options measured when this was written. A release dropping one changes what the tool
    // reports about real configurations, so they are asserted rather than assumed.
    for (const [option, value] of [
      ["poweredByHeader", true],
      ["compress", true],
      ["basePath", ""],
      ["distDir", ".next"],
      ["trailingSlash", false],
      ["typedRoutes", false],
    ] as const) {
      expect(defaults.value.get(option), option).toBe(value);
    }
  });

  it.each(available)("should skip the options whose default is an object on $name", (fixture) => {
    const defaults = readOptionDefaults(installedOf(fixture));
    if (defaults.status !== "resolved") return;
    // `images` and `typescript` hold shapes. A shape and a value are different questions, and
    // flattening one into the other would compare a project's object against a name. Their
    // scalars are read under their own dotted keys, which is the case below.
    expect(defaults.value.has("images")).toBe(false);
    expect(defaults.value.has("typescript")).toBe(false);
    expect(defaults.value.has("onDemandEntries")).toBe(false);
  });

  it.each(available)(
    "should read the scalars one level inside those objects on $name",
    (fixture) => {
      const defaults = readOptionDefaults(installedOf(fixture));
      if (defaults.status !== "resolved") return;
      // Pinned by name rather than counted: a release moving one of these changes what the tool
      // says about a real configuration, and a count would absorb that silently. All four hold on
      // 16.2.4, 16.2.6 and 16.3.0.
      for (const [key, value] of [
        ["typescript.ignoreBuildErrors", false],
        ["devIndicators.position", "bottom-left"],
        ["onDemandEntries.pagesBufferLength", 5],
        ["httpAgentOptions.keepAlive", true],
      ] as const) {
        expect(defaults.value.get(key), key).toBe(value);
      }
    },
  );

  it.each(available)(
    "should read the experimental container like any other on $name",
    (fixture) => {
      const defaults = readOptionDefaults(installedOf(fixture));
      if (defaults.status !== "resolved") return;
      // It was left out, on the ground that a finding keyed under its own name would have nowhere to
      // appear. Where a finding lands is the comparison's decision; what the release applies is this
      // reader's, and it applies these.
      for (const [key, value] of [
        ["experimental.cssChunking", true],
        ["experimental.serverMinification", true],
        ["experimental.turbopackFileSystemCacheForDev", true],
      ] as const) {
        expect(defaults.value.get(key), key).toBe(value);
      }
      // The container itself holds a shape, so it is not compared as a value.
      expect(defaults.value.has("experimental")).toBe(false);
    },
  );

  it.each(available)("should not descend past one level on $name", (fixture) => {
    const defaults = readOptionDefaults(installedOf(fixture));
    if (defaults.status !== "resolved") return;
    const deeper = [...defaults.value.keys()].filter((key) => key.split(".").length > 2);
    expect(deeper).toEqual([]);
  });

  it("should be unresolved when there is no installed package", () => {
    expect(readOptionDefaults(undefined).status).toBe("unresolved");
  });

  it("should be unresolved, naming the anchor, when the object is gone", () => {
    const decoy: InstalledNext = { realPath: NOWHERE, linkPath: NOWHERE, version: "16.3.0" };
    const result = readOptionDefaults(decoy);
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") return;
    expect(result.reason).toContain("config-shared.js");
  });

  it("should refuse a release whose object yields a handful, rather than believe it", () => {
    // A shape that moved is what the floor is for, and the floor is a lower bound rather than a
    // proportion: the map is a hundred keys now and the number that says the pattern found
    // something else is still a handful.
    const root = mkdtempSync(join(tmpdir(), "next-coverage-defaults-"));
    const file = join(root, "dist", "esm", "server", "config-shared.js");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      ["export const defaultConfig = Object.freeze({", "    compress: true,", "});", ""].join("\n"),
    );
    const truncated = readOptionDefaults({ realPath: root, linkPath: root, version: "16.3.0" });
    expect(truncated.status).toBe("unresolved");
    if (truncated.status !== "unresolved") return;
    expect(truncated.reason).toContain("scalar options");
  });

  it.each(available)("should not run past the object into the module on $name", (fixture) => {
    const defaults = readOptionDefaults(installedOf(fixture));
    if (defaults.status !== "resolved") return;
    // The cacheLife profiles are a sibling object in the same file. Collecting their keys would
    // mean the balanced-brace cut failed.
    expect(defaults.value.has("seconds")).toBe(false);
    expect(defaults.value.has("minutes")).toBe(false);
  });
});

describe("the expression naming the crawlers served blocking metadata", () => {
  it.each(available)("should read it from the installed release on $name", (fixture) => {
    const found = readHtmlLimitedBots(installedOf(fixture));
    expect(found.status).toBe("resolved");
    if (found.status !== "resolved") return;
    // The members the condition rests on. A release dropping one of these changes what the tool
    // reports about real projects, so they are asserted rather than assumed.
    expect(found.value.test("Bingbot")).toBe(true);
    expect(found.value.test("Twitterbot")).toBe(true);
    expect(found.value.test("Slackbot")).toBe(true);
    expect(found.value.test("MiRastreador")).toBe(false);
  });

  it("should report unresolved with the file name when the module is absent", () => {
    const installed: InstalledNext = { realPath: NOWHERE, linkPath: NOWHERE, version: "16.3.0" };
    const found = readHtmlLimitedBots(installed);
    expect(found.status).toBe("unresolved");
    if (found.status !== "unresolved") return;
    expect(found.reason).toContain("html-bots.js");
  });

  it("should report unresolved with no installed package at all", () => {
    expect(readHtmlLimitedBots(undefined).status).toBe("unresolved");
  });

  /**
   * A short expression is a pattern that matched something other than the list. Reporting it would
   * make every agent a project names look uncovered, which is a finding about the reader.
   */
  it("should refuse an expression far shorter than the list is known to be", () => {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-bots-"));
    const file = join(root, "dist", "shared", "lib", "router", "utils", "html-bots.js");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "const HTML_LIMITED_BOT_UA_RE = /Bingbot|Slackbot/i;\n");
    const found = readHtmlLimitedBots({ realPath: root, linkPath: root, version: "16.3.0" });
    expect(found.status).toBe("unresolved");
    if (found.status !== "unresolved") return;
    expect(found.reason).toContain("alternatives");
  });

  it("should refuse a declaration that is no longer a regular-expression literal", () => {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-bots-"));
    const file = join(root, "dist", "shared", "lib", "router", "utils", "html-bots.js");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "const HTML_LIMITED_BOT_UA_RE = buildExpression(NAMES);\n");
    const found = readHtmlLimitedBots({ realPath: root, linkPath: root, version: "16.3.0" });
    expect(found.status).toBe("unresolved");
    if (found.status !== "unresolved") return;
    expect(found.reason).toContain("regular-expression literal");
  });
});

/**
 * The reading `expireTime` is settled on. The installed release
 * writes the default as a ternary on an environment variable rather than as a literal, so the
 * scalar reader yields nothing for it — which is what closed the reopening rather than a condition
 * being written against a number nobody could read.
 */
describe.skipIf(available.length === 0)("the defaults a scalar reader cannot reach", () => {
  it.each(available)("should yield no expireTime on $name", (fixture) => {
    const defaults = readOptionDefaults(installedOf(fixture));
    expect(defaults.status).toBe("resolved");
    if (defaults.status !== "resolved") return;
    expect(defaults.value.get("expireTime")).toBeUndefined();
    // The reader does resolve, and holds scalars from the same object. So the absence above is the
    // ternary and not a read that failed.
    expect(defaults.value.get("reactMaxHeadersLength")).toBe(6000);
  });
});
