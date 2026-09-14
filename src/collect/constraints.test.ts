import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureRoot } from "../../test-support/corpus.js";
import type { Resolved } from "../types.js";
import { DEFAULT_PAGE_EXTENSIONS, resolved, unresolved } from "../types.js";
import type { NextConfigSource } from "./config.js";
import { readNextConfig } from "./config.js";
import {
  buildAbsentPrerequisite,
  buildBundlerScope,
  buildConstraints,
  buildDefaultRestatements,
  buildFailingCombination,
  buildMissingModules,
  buildRouteInterceptions,
  buildSegmentConfigRemoved,
  buildUnprefixedAssets,
  CACHE_COMPONENTS_ENTRY,
  reasonNaming,
  SLOT_MODE_ENTRY,
} from "./constraints.js";
import type { FrameworkDefaults } from "./defaults.js";
import { buildGraph } from "./graph.js";
import type { Bundler } from "./project.js";
import { buildRouteTree } from "./routes.js";
import { scanSources } from "./sources.js";

/**
 * A throwaway project with an `app` directory, so the tree and the graph read the same files. The
 * graph resolves relative specifiers, so the fixtures below import by path rather than by alias.
 */
function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-constraints-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const appDirectory = join(root, "app");
  mkdirSync(appDirectory, { recursive: true });
  const tree = buildRouteTree({
    appDirectory,
    pageExtensions: DEFAULT_PAGE_EXTENSIONS,
    isFlagEnabled: () => true,
  });
  const sources = scanSources(root);
  return {
    report: buildConstraints(sources, tree, buildGraph(sources)),
    at: (name: string) => join(root, name),
  };
}

const STATIC_SLOT = "export default function Slot() { return null }\n";
const DYNAMIC_SLOT =
  "import { headers } from 'next/headers';\nexport default async function Slot() { return (await headers()).get('x') }\n";

describe("slots of one segment share a rendering mode", () => {
  it("should report a static slot beside a dynamic one, naming the cause", () => {
    const { report, at } = project({
      "app/@quiet/default.tsx": STATIC_SLOT,
      "app/@loud/default.tsx": DYNAMIC_SLOT,
    });
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0];
    expect(finding?.entry).toBe(SLOT_MODE_ENTRY);
    expect(finding?.segment).toBe(at("app"));
    expect(finding?.staticSlots.map((s) => s.slot)).toEqual(["quiet"]);
    expect(finding?.cause).toBe("loud");
    expect(finding?.otherDynamic).toBe(0);
  });

  it("should read a slot as dynamic when its own file calls the api", () => {
    const { report } = project({
      "app/@a/default.tsx": DYNAMIC_SLOT,
      "app/@b/default.tsx": STATIC_SLOT,
    });
    // A chain of one: the convention file decided it, with no import in between.
    expect(report.findings[0]?.causeChain).toHaveLength(1);
  });

  it("should read a slot as dynamic through a module it imports", () => {
    const { report, at } = project({
      "app/@loud/default.tsx":
        "import { read } from '../../lib/session';\nexport default async function Slot() { return read() }\n",
      "lib/session.ts":
        "import { headers } from 'next/headers';\nexport async function read() { return (await headers()).get('x') }\n",
      "app/@quiet/default.tsx": STATIC_SLOT,
    });
    expect(report.findings[0]?.cause).toBe("loud");
    expect(report.findings[0]?.causeChain).toEqual([
      at("app/@loud/default.tsx"),
      at("lib/session.ts"),
    ]);
  });

  it("should read a slot as static when nothing it reaches calls the api", () => {
    const { report } = project({
      "app/@quiet/default.tsx":
        "import { label } from '../../lib/copy';\nexport default function Slot() { return label }\n",
      "lib/copy.ts": "export const label = 'hola'\n",
      "app/@loud/default.tsx": DYNAMIC_SLOT,
    });
    expect(report.findings[0]?.staticSlots.map((s) => s.slot)).toEqual(["quiet"]);
  });

  // Its own function of the same name is its own function. Reading it as the framework's would
  // decide the rendering mode from a name rather than from a resolved import.
  it("should ignore a call to a project-local function of the same name", () => {
    const { report } = project({
      "app/@quiet/default.tsx": STATIC_SLOT,
      "app/@alsoquiet/default.tsx":
        "import { headers } from '../../lib/http';\nexport default function Slot() { return headers() }\n",
      "lib/http.ts": "export function headers() { return null }\n",
    });
    expect(report.findings).toEqual([]);
  });

  it("should say nothing when every slot is dynamic", () => {
    const { report } = project({
      "app/@a/default.tsx": DYNAMIC_SLOT,
      "app/@b/default.tsx": DYNAMIC_SLOT,
    });
    expect(report.findings).toEqual([]);
  });

  it("should say nothing when every slot is static", () => {
    const { report } = project({
      "app/@a/default.tsx": STATIC_SLOT,
      "app/@b/default.tsx": STATIC_SLOT,
    });
    expect(report.findings).toEqual([]);
  });

  it("should say nothing about a segment holding one slot", () => {
    const { report } = project({
      "app/@only/default.tsx": DYNAMIC_SLOT,
      "app/page.tsx": STATIC_SLOT,
    });
    expect(report.findings).toEqual([]);
  });

  // The constraint is stated per segment level, so slots that never share a parent never disagree.
  it("should say nothing about slots under different parents", () => {
    const { report } = project({
      "app/shop/@quiet/default.tsx": STATIC_SLOT,
      "app/shop/page.tsx": STATIC_SLOT,
      "app/admin/@loud/default.tsx": DYNAMIC_SLOT,
      "app/admin/page.tsx": STATIC_SLOT,
    });
    expect(report.findings).toEqual([]);
  });

  it("should count the dynamic siblings it did not name", () => {
    const { report } = project({
      "app/@quiet/default.tsx": STATIC_SLOT,
      "app/@a/default.tsx": DYNAMIC_SLOT,
      "app/@b/default.tsx": DYNAMIC_SLOT,
    });
    expect(report.findings[0]?.otherDynamic).toBe(1);
  });

  it("should list every static slot losing prerendering", () => {
    const { report } = project({
      "app/@one/default.tsx": STATIC_SLOT,
      "app/@two/default.tsx": STATIC_SLOT,
      "app/@loud/default.tsx": DYNAMIC_SLOT,
    });
    expect(report.findings[0]?.staticSlots.map((s) => s.slot).sort()).toEqual(["one", "two"]);
  });

  // A slot's subtree renders inside it, so a page below the slot decides its mode too.
  it("should read a slot as dynamic through a route below it", () => {
    const { report } = project({
      "app/@loud/default.tsx": STATIC_SLOT,
      "app/@loud/detail/page.tsx": DYNAMIC_SLOT,
      "app/@quiet/default.tsx": STATIC_SLOT,
    });
    expect(report.findings[0]?.cause).toBe("loud");
  });

  it("should order the findings by segment, so repeated runs match", () => {
    const { report, at } = project({
      "app/shop/@quiet/default.tsx": STATIC_SLOT,
      "app/shop/@loud/default.tsx": DYNAMIC_SLOT,
      "app/admin/@quiet/default.tsx": STATIC_SLOT,
      "app/admin/@loud/default.tsx": DYNAMIC_SLOT,
    });
    expect(report.findings.map((f) => f.segment)).toEqual([at("app/admin"), at("app/shop")]);
  });

  it("should state that the constraint was checked even when nothing is contradicted", () => {
    const { report } = project({ "app/page.tsx": STATIC_SLOT });
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(1);
  });
});

describe("the configuration restates a framework default", () => {
  const DEFAULTS = {
    optimizedImports: resolved(new Set(["lucide-react", "recharts"])),
    serverExternals: resolved(new Set(["sharp"])),
    transpiled: resolved(new Set(["geist"])),
    cacheProfiles: resolved(new Set(["default", "seconds", "minutes"])),
    optionDefaults: resolved(
      new Map<string, string | number | boolean | null>([
        ["poweredByHeader", true],
        ["basePath", ""],
        ["reactMaxHeadersLength", 6000],
        ["reactStrictMode", null],
        ["trailingSlash", false],
      ]),
    ),
  };

  function configWith(contents: string): NextConfigSource | undefined {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-defaults-"));
    writeFileSync(join(root, "next.config.ts"), contents);
    return readNextConfig(root);
  }

  /**
   * The catalog identifiers these assertions are written against. A finding needs an entry to
   * appear on, and the cases below are about what the comparison says when there is one — the
   * case where there is not has its own block.
   */
  const ALL_ENTRIES = new Set(
    [
      "optimizePackageImports",
      "serverExternalPackages",
      "transpilePackages",
      "poweredByHeader",
      "basePath",
      "reactMaxHeadersLength",
      "reactStrictMode",
      "trailingSlash",
      "typescript",
    ].map((option) => `config/next-config-js/${option}`),
  );

  describe("the page a nested finding lands on", () => {
    const WITH_PAGES = new Set(
      ["taint", "typescript", "turbopackFileSystemCache"].map(
        (option) => `config/next-config-js/${option}`,
      ),
    );
    const PAGES_BY_KEY = new Map([
      ["experimental.turbopackFileSystemCacheForDev", "turbopackFileSystemCache"],
    ]);

    const restatementsOf = (contents: string, option: string, value: boolean) =>
      buildDefaultRestatements(
        configWith(contents),
        { ...DEFAULTS, optionDefaults: resolved(new Map([[option, value]])) },
        WITH_PAGES,
        PAGES_BY_KEY,
      );

    it("should carry the page named after the key, not after the container", () => {
      const { findings } = restatementsOf(
        "export default { experimental: { taint: true } };",
        "experimental.taint",
        true,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.entry).toBe("config/next-config-js/taint");
      expect(findings[0]?.option).toBe("experimental.taint");
    });

    it("should fall back to the container where no page carries the key", () => {
      const { findings } = restatementsOf(
        "export default { typescript: { ignoreBuildErrors: false } };",
        "typescript.ignoreBuildErrors",
        false,
      );
      expect(findings[0]?.entry).toBe("config/next-config-js/typescript");
    });

    it("should reach the page that documents a key under another name", () => {
      const { findings } = restatementsOf(
        "export default { experimental: { turbopackFileSystemCacheForDev: true } };",
        "experimental.turbopackFileSystemCacheForDev",
        true,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.entry).toBe("config/next-config-js/turbopackFileSystemCache");
    });

    it("should count a key with no page anywhere among the defaults walked past", () => {
      const result = restatementsOf(
        "export default { experimental: { coldCacheBadge: false } };",
        "experimental.coldCacheBadge",
        false,
      );
      expect(result.findings).toEqual([]);
      expect(result.withoutEntry).toBe(1);
    });
  });

  it("should name the key, and hang the finding on the option that holds it", () => {
    // `typescript` defaults to an object, so its scalars were invisible to the comparison until
    // it read one level down. The finding belongs to `typescript`: the dotted path names no page.
    const config = configWith("export default { typescript: { ignoreBuildErrors: false } };");
    const defaults = {
      ...DEFAULTS,
      optionDefaults: resolved(new Map([["typescript.ignoreBuildErrors", false]])),
    };
    const { findings } = buildDefaultRestatements(config, defaults, ALL_ENTRIES);
    const restated = findings.filter((finding) => finding.kind === "restates-default");
    expect(restated).toHaveLength(1);
    expect(restated[0]?.option).toBe("typescript.ignoreBuildErrors");
    expect(restated[0]?.entry).toBe("config/next-config-js/typescript");
  });

  it("should say nothing when the nested value differs from the default", () => {
    const config = configWith("export default { typescript: { ignoreBuildErrors: true } };");
    const defaults = {
      ...DEFAULTS,
      optionDefaults: resolved(new Map([["typescript.ignoreBuildErrors", false]])),
    };
    const restated = buildDefaultRestatements(config, defaults, ALL_ENTRIES).findings.filter(
      (finding) => finding.kind === "restates-default",
    );
    expect(restated).toEqual([]);
  });

  it("should say nothing about a key the default object does not carry", () => {
    const config = configWith(
      "export default { typescript: { tsconfigPath: './tsconfig.json' } };",
    );
    const defaults = {
      ...DEFAULTS,
      optionDefaults: resolved(new Map([["typescript.ignoreBuildErrors", false]])),
    };
    const restated = buildDefaultRestatements(config, defaults, ALL_ENTRIES).findings.filter(
      (finding) => finding.kind === "restates-default",
    );
    expect(restated).toEqual([]);
  });

  it("should name only the declared packages that are already on the list", () => {
    const config = configWith(
      "export default { optimizePackageImports: ['lucide-react', '@acme/icons'] };",
    );
    const { findings, checked } = buildDefaultRestatements(config, DEFAULTS, ALL_ENTRIES);
    // Three package lists and the scalar comparison, which is one constraint over every option
    // carrying a readable default rather than one per option.
    expect(checked).toBe(4);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.packages).toEqual(["lucide-react"]);
    expect(findings[0]?.entry).toBe("config/next-config-js/optimizePackageImports");
    expect(findings[0]?.whatNextDoes).toContain("already optimizes");
  });

  it("should report nothing when every declared package does work", () => {
    const config = configWith("export default { optimizePackageImports: ['@acme/icons'] };");
    expect(buildDefaultRestatements(config, DEFAULTS, ALL_ENTRIES).findings).toEqual([]);
  });

  it("should report nothing when the option is not declared", () => {
    const config = configWith("export default { reactStrictMode: true };");
    expect(buildDefaultRestatements(config, DEFAULTS, ALL_ENTRIES).findings).toEqual([]);
  });

  it("should answer for the server-external option from its own list", () => {
    const config = configWith("export default { serverExternalPackages: ['sharp', 'unpdf'] };");
    const { findings } = buildDefaultRestatements(config, DEFAULTS, ALL_ENTRIES);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.packages).toEqual(["sharp"]);
    expect(findings[0]?.whatNextDoes).toContain("server-external");
  });

  it("should stay silent, and count nothing checked, when a list is unresolved", () => {
    const config = configWith("export default { optimizePackageImports: ['lucide-react'] };");
    const { findings, checked } = buildDefaultRestatements(
      config,
      {
        optimizedImports: unresolved("the file moved"),
        serverExternals: unresolved("the file moved"),
        transpiled: unresolved("the file moved"),
        cacheProfiles: unresolved("the file moved"),
        optionDefaults: unresolved("the file moved"),
      },
      ALL_ENTRIES,
    );
    expect(findings).toEqual([]);
    // A list that could not be read was not checked against. Counting it would report a check
    // that never happened.
    expect(checked).toBe(0);
  });

  it("should stay silent when a spread hides every name the array holds", () => {
    // The reader resolves this array to zero readable names and one skipped element. Nothing
    // was read, so there is nothing to compare, and a spread must never be read as empty.
    const config = configWith(
      "const extra = ['lucide-react'];\nexport default { optimizePackageImports: [...extra] };",
    );
    const { findings } = buildDefaultRestatements(config, DEFAULTS, ALL_ENTRIES);
    expect(findings).toEqual([]);
  });

  it("should report the names it did read when a spread hides only some of them", () => {
    // Half a list is still evidence about the half that was read. The hidden element cannot
    // add a finding, and it does not take away the one that is plainly there.
    const config = configWith(
      "const extra = ['@acme/icons'];\n" +
        "export default { optimizePackageImports: ['lucide-react', ...extra] };",
    );
    const { findings } = buildDefaultRestatements(config, DEFAULTS, ALL_ENTRIES);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.packages).toEqual(["lucide-react"]);
  });

  it("should answer for the transpiled option from its own list", () => {
    const config = configWith("export default { transpilePackages: ['geist', '@acme/ui'] };");
    const { findings } = buildDefaultRestatements(config, DEFAULTS, ALL_ENTRIES);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.packages).toEqual(["geist"]);
    expect(findings[0]?.entry).toBe("config/next-config-js/transpilePackages");
    expect(findings[0]?.whatNextDoes).toContain("already transpiles");
  });

  it("should say nothing about a package the project transpiles on its own account", () => {
    const config = configWith("export default { transpilePackages: ['@acme/ui'] };");
    expect(buildDefaultRestatements(config, DEFAULTS, ALL_ENTRIES).findings).toEqual([]);
  });

  it("should produce no finding for a default whose option has no page", () => {
    // `cleanDistDir` is one of ten scalars the installed release carries a default for and
    // documents no page for. Before this, restating it raised the contradiction count and then
    // matched no entry when the report looked for somewhere to print it.
    const config = configWith("export default { cleanDistDir: true };");
    const defaults = {
      ...DEFAULTS,
      optionDefaults: resolved(
        new Map<string, string | number | boolean | null>([["cleanDistDir", true]]),
      ),
    };
    const { findings, withoutEntry } = buildDefaultRestatements(config, defaults, ALL_ENTRIES);
    expect(findings.filter((finding) => finding.kind === "restates-default")).toEqual([]);
    expect(withoutEntry).toBe(1);
  });

  it("should still report the same default once its option has an entry", () => {
    // The gate is about reachability, not about the comparison: the identical configuration
    // reports when the catalog holds the page.
    const config = configWith("export default { cleanDistDir: true };");
    const defaults = {
      ...DEFAULTS,
      optionDefaults: resolved(
        new Map<string, string | number | boolean | null>([["cleanDistDir", true]]),
      ),
    };
    const withPage = new Set([...ALL_ENTRIES, "config/next-config-js/cleanDistDir"]);
    const { findings, withoutEntry } = buildDefaultRestatements(config, defaults, withPage);
    expect(findings.filter((finding) => finding.kind === "restates-default")).toHaveLength(1);
    expect(withoutEntry).toBe(0);
  });

  it("should count every default it passed over, configured or not", () => {
    // The figure is about what the release documents, not about what this project sets: a
    // reader comparing checked against passed-over is asking about the release.
    const config = configWith("export default {};");
    const defaults = {
      ...DEFAULTS,
      optionDefaults: resolved(
        new Map<string, string | number | boolean | null>([
          ["cleanDistDir", true],
          ["i18n", null],
          ["poweredByHeader", true],
        ]),
      ),
    };
    expect(buildDefaultRestatements(config, defaults, ALL_ENTRIES).withoutEntry).toBe(2);
  });

  it("should report nothing when there is no configuration at all", () => {
    expect(buildDefaultRestatements(undefined, DEFAULTS, ALL_ENTRIES)).toEqual({
      findings: [],
      checked: 0,
      withoutEntry: 0,
    });
  });
});

describe("an option set to the value the framework already applies", () => {
  const DEFAULTS: FrameworkDefaults = {
    optimizedImports: unresolved("not part of this question"),
    serverExternals: unresolved("not part of this question"),
    transpiled: unresolved("not part of this question"),
    cacheProfiles: unresolved("not part of this question"),
    optionDefaults: resolved(
      new Map<string, string | number | boolean | null>([
        ["poweredByHeader", true],
        ["basePath", ""],
        ["reactMaxHeadersLength", 6000],
        ["reactStrictMode", null],
        ["trailingSlash", false],
      ]),
    ),
  };

  /** The options these scalar cases are about, each one a page the catalog holds an entry for. */
  const SCALAR_ENTRIES = new Set(
    [
      "poweredByHeader",
      "basePath",
      "reactMaxHeadersLength",
      "reactStrictMode",
      "trailingSlash",
      "compress",
    ].map((option) => `config/next-config-js/${option}`),
  );

  function configWith(contents: string): NextConfigSource | undefined {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-scalars-"));
    writeFileSync(join(root, "next.config.ts"), contents);
    return readNextConfig(root);
  }

  const findingsFor = (contents: string) =>
    buildDefaultRestatements(configWith(contents), DEFAULTS, SCALAR_ENTRIES).findings;

  it.each([
    ["a boolean", "export default { poweredByHeader: true };", "poweredByHeader"],
    ["a string", "export default { basePath: '' };", "basePath"],
    ["a number", "export default { reactMaxHeadersLength: 6000 };", "reactMaxHeadersLength"],
    ["null", "export default { reactStrictMode: null };", "reactStrictMode"],
  ])("should report %s set to its own default", (_label, contents, option) => {
    const findings = findingsFor(contents);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.option).toBe(option);
    expect(findings[0]?.entry).toBe(`config/next-config-js/${option}`);
    expect(findings[0]?.whatNextDoes).toContain("already applies");
  });

  it.each([
    ["a boolean", "export default { poweredByHeader: false };"],
    ["a string", "export default { basePath: '/app' };"],
    ["a number", "export default { reactMaxHeadersLength: 8000 };"],
    ["null against a value", "export default { reactStrictMode: true };"],
  ])("should say nothing about %s set to something else", (_label, contents) => {
    // The line changes what the framework does, which is what setting an option is for.
    expect(findingsFor(contents)).toEqual([]);
  });

  it("should say nothing about an option whose value did not resolve", () => {
    expect(findingsFor("export default { poweredByHeader: process.env.X === '1' };")).toEqual([]);
  });

  it("should say nothing when the defaults could not be read", () => {
    const findings = buildDefaultRestatements(
      configWith("export default { compress: true };"),
      { ...DEFAULTS, optionDefaults: unresolved("the object moved") },
      SCALAR_ENTRIES,
    ).findings;
    expect(findings).toEqual([]);
  });

  it("should report every option a config restates, not only the first", () => {
    const findings = findingsFor("export default { poweredByHeader: true, trailingSlash: false };");
    expect(findings.map((finding) => finding.option).sort()).toEqual([
      "poweredByHeader",
      "trailingSlash",
    ]);
  });
});

describe("a path the configuration routes away from", () => {
  function projectWith(config: string, files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-intercept-"));
    writeFileSync(join(root, "next.config.ts"), config);
    for (const [relativePath, contents] of Object.entries(files)) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    const tree = buildRouteTree({
      appDirectory: join(root, "app"),
      pageExtensions: DEFAULT_PAGE_EXTENSIONS,
      isFlagEnabled: () => true,
    });
    return { config: readNextConfig(root), tree };
  }

  const HANDLER = "export function GET() { return new Response('x'); }";

  it("should name the file that answers at a redirected path", () => {
    const { config, tree } = projectWith(
      [
        "export default {",
        "  async redirects() {",
        "    return [{ source: '/favicon.png', destination: '/favicon.svg', permanent: true }];",
        "  },",
        "};",
      ].join("\n"),
      { "app/favicon.png/route.ts": HANDLER, "app/page.tsx": "export default () => null;" },
    );
    const { findings, checked } = buildRouteInterceptions(config, tree);
    expect(checked).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.option).toBe("redirects");
    expect(findings[0]?.routes[0]?.pattern).toBe("/favicon.png");
    expect(findings[0]?.routes[0]?.serves).toContain("favicon.png/route.ts");
  });

  it("should read the rules through an await and a resolved promise", () => {
    // The primary fixture writes `return await Promise.resolve([...])`, which read as an option
    // nobody had written until the reader peeled both.
    const { config, tree } = projectWith(
      [
        "export default {",
        "  async redirects() {",
        "    return await Promise.resolve([",
        "      { source: '/vieja', destination: '/nueva', permanent: true },",
        "    ]);",
        "  },",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    expect(buildRouteInterceptions(config, tree).findings).toHaveLength(1);
  });

  it("should read both sides of a rule list a condition turns on", () => {
    // `darkroomengineering/satus` gates its Storybook proxy on the environment, writing the rules
    // on one side of a conditional and an empty list on the other. Reading neither made a file
    // that states its rules literally report as stating nothing.
    const { config, tree } = projectWith(
      [
        "export default {",
        "  rewrites: async () =>",
        "    PROXY_ENABLED",
        "      ? [{ source: '/vieja', destination: 'https://example.test/vieja' }]",
        "      : [],",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings, checked } = buildRouteInterceptions(config, tree);
    expect(checked).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.option).toBe("rewrites");
  });

  it("should read the phased form rewrites documents beside the plain list", () => {
    // `mdugue/manuel-dugue` returns `{ beforeFiles: [ … ] }` with every rule written out. The
    // phases decide when each list applies, not what it holds.
    const { config, tree } = projectWith(
      [
        "export default {",
        "  rewrites: async () => ({",
        "    beforeFiles: [{ source: '/vieja', destination: '/nueva' }],",
        "  }),",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings, checked, unread } = buildRouteInterceptions(config, tree);
    expect(checked).toBe(2);
    expect(unread).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.option).toBe("rewrites");
  });

  it("should read every documented phase, not only the first", () => {
    const { config, tree } = projectWith(
      [
        "export default {",
        "  rewrites: async () => ({",
        "    beforeFiles: [{ source: '/otra', destination: '/x' }],",
        "    afterFiles: [{ source: '/vieja', destination: '/nueva' }],",
        "    fallback: [],",
        "  }),",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings } = buildRouteInterceptions(config, tree);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.routes.map((route) => route.pattern)).toEqual(["/vieja"]);
  });

  it("should not read the phased form from an option that does not document it", () => {
    // `redirects` takes a list and nothing else. An object returned from it is a value the
    // framework does not read either, so reading one would report rules nobody serves.
    const { config, tree } = projectWith(
      [
        "export default {",
        "  redirects: async () => ({",
        "    beforeFiles: [{ source: '/vieja', destination: '/nueva', permanent: true }],",
        "  }),",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings, unread } = buildRouteInterceptions(config, tree);
    expect(findings).toEqual([]);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.subject).toBe("redirects");
  });

  it("should say nothing about an option nobody wrote", () => {
    const { config, tree } = projectWith("export default { basePath: '/x' };", {
      "app/vieja/page.tsx": "export default () => null;",
    });
    const { findings, unread } = buildRouteInterceptions(config, tree);
    expect(findings).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("should name the spread, not a shape, for an option nobody wrote", () => {
    // Under an opaque spread this used to report that `redirects` was written in a form it could
    // not read, of a file that writes no `redirects` at all. A reader describing writing the file
    // does not contain is worse than one saying it could not tell.
    const { config, tree } = projectWith("export default { ...makeBase(), basePath: '/x' };", {
      "app/vieja/page.tsx": "export default () => null;",
    });
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread).toHaveLength(2);
    for (const reading of unread) {
      expect(reading.reason).toContain("may come from a spread");
      expect(reading.reason).not.toContain("not written as a function");
    }
  });

  it("should still name the shape for an option the file does write", () => {
    const { config, tree } = projectWith("export default { redirects, basePath: '/x' };", {
      "app/vieja/page.tsx": "export default () => null;",
    });
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread.find((reading) => reading.subject === "redirects")?.reason).toContain(
      "not written as a function",
    );
  });

  it("should refuse an object carrying none of the documented phases", () => {
    const { config, tree } = projectWith(
      [
        "export default {",
        "  rewrites: async () => ({ proxies: [{ source: '/vieja', destination: '/nueva' }] }),",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.reason).toContain("cannot read as a list of rules");
  });

  it("should count a phase it cannot read beside one it can", () => {
    // A sibling phase that reads would otherwise return from the walk and leave the unread one
    // with no trace, reporting an option read in part as an option read in full.
    const { config, tree } = projectWith(
      [
        "export default {",
        "  rewrites: async () => ({",
        "    beforeFiles: [{ source: '/vieja', destination: '/nueva' }],",
        "    afterFiles() { return computed(); },",
        "  }),",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings } = buildRouteInterceptions(config, tree);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.routes.map((route) => route.pattern)).toEqual(["/vieja"]);
    expect(findings[0]?.unread).toBe(1);
  });

  it("should refuse a spread of a name the body reassigns before returning", () => {
    // What the name was declared with is not what the framework receives. Reading the first
    // binding would report a rule nobody wrote against a route the project really serves.
    const { config, tree } = projectWith(
      [
        "export default {",
        "  rewrites: async () => {",
        "    let known = [{ source: '/vieja', destination: '/nueva' }];",
        "    known = computeDynamic();",
        "    return [...known];",
        "  },",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    expect(buildRouteInterceptions(config, tree).findings).toEqual([]);
  });

  it("should keep refusing a reassigned list even where the assignment wraps it", () => {
    // The pin on the other side of the relaxation the configuration walk takes. Wrapping a
    // configuration leaves it the same configuration; wrapping a list of rules does not leave it
    // the same list, and these are checked against routes the project really serves. Whether that
    // relaxation is safe here is a separate question with its own measurement, and this asserts
    // nobody answered it by accident.
    const { config, tree } = projectWith(
      [
        "export default {",
        "  rewrites: async () => {",
        "    let known = [{ source: '/vieja', destination: '/nueva' }];",
        "    known = withExtra(known);",
        "    return [...known];",
        "  },",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    expect(buildRouteInterceptions(config, tree).findings).toEqual([]);
  });

  it("should count a phase built by a call rather than dropping it", () => {
    // The partial-is-partial contract: a spread this reader cannot follow is counted, so a list
    // read in part is never reported as a list read in full.
    const { config, tree } = projectWith(
      [
        "const known = [{ source: '/vieja', destination: '/nueva' }];",
        "export default {",
        "  rewrites: async () => ({",
        "    afterFiles: [...known, ...buildTheRest()],",
        "  }),",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings } = buildRouteInterceptions(config, tree);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.unread).toBe(1);
  });

  it("should follow an option naming a function declared in the same file", () => {
    // `nakafaai/nakafa.com` writes exactly this: the documented signature moved out of the object,
    // not changed. Both of its interception checks went unrun while this was unread.
    const { config, tree } = projectWith(
      [
        "function createRewrites() {",
        "  return [{ source: '/vieja', destination: '/nueva' }];",
        "}",
        "export default {",
        "  rewrites: createRewrites,",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings, checked, unread } = buildRouteInterceptions(config, tree);
    expect(checked).toBe(2);
    expect(unread).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.option).toBe("rewrites");
  });

  it("should follow an option naming a function a variable holds", () => {
    const { config, tree } = projectWith(
      [
        "const createRewrites = async () => [{ source: '/vieja', destination: '/nueva' }];",
        "export default {",
        "  rewrites: createRewrites,",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings, checked } = buildRouteInterceptions(config, tree);
    expect(checked).toBe(2);
    expect(findings).toHaveLength(1);
  });

  it("should refuse a name the file declares twice", () => {
    // Two declarations settle nothing, and picking one would read rules the project may not serve.
    const { config, tree } = projectWith(
      [
        "function createRewrites() { return [{ source: '/vieja', destination: '/nueva' }]; }",
        "function createRewrites() { return []; }",
        "export default {",
        "  rewrites: createRewrites,",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.reason).toContain("not written as a function this can read");
  });

  it("should refuse a name the file assigns to after declaring it", () => {
    // What the name holds when the framework calls it is not what it was declared with, and this
    // reader does not run the file to find out which one arrives.
    const { config, tree } = projectWith(
      [
        "let createRewrites = () => [{ source: '/vieja', destination: '/nueva' }];",
        "createRewrites = () => [];",
        "export default {",
        "  rewrites: createRewrites,",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.reason).toContain("not written as a function this can read");
  });

  it("should refuse a declared function the file assigns over", () => {
    // The same refusal reached by the other door: the name comes from a function statement rather
    // than from a variable, and the assignment replaces it just the same.
    const { config, tree } = projectWith(
      [
        "function createRewrites() { return [{ source: '/vieja', destination: '/nueva' }]; }",
        "createRewrites = () => [];",
        "export default {",
        "  rewrites: createRewrites,",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.reason).toContain("not written as a function this can read");
  });

  it("should refuse a name a compound assignment rebinds", () => {
    // `??=` rebinds as plainly as `=`. Reading only `=` followed the declaration the file goes on
    // to replace, which is the one direction this reader must not err in.
    const { config, tree } = projectWith(
      [
        "function createRewrites() { return [{ source: '/vieja', destination: '/nueva' }]; }",
        "createRewrites ??= () => [];",
        "export default {",
        "  rewrites: createRewrites,",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.reason).toContain("not written as a function this can read");
  });

  it("should refuse a name a destructuring assignment rebinds", () => {
    const { config, tree } = projectWith(
      [
        "function createRewrites() { return [{ source: '/vieja', destination: '/nueva' }]; }",
        "({ createRewrites } = await import('./rules.js'));",
        "export default {",
        "  rewrites: createRewrites,",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread).toHaveLength(1);
  });

  it("should refuse a name held by both a function and a variable", () => {
    // `var` and a function statement may share a name, and the file then settles two functions
    // under it. Which one the framework receives is not knowable without running the file.
    const { config, tree } = projectWith(
      [
        "function createRewrites() { return [{ source: '/vieja', destination: '/nueva' }]; }",
        "var createRewrites = () => [];",
        "export default {",
        "  rewrites: createRewrites,",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.reason).toContain("not written as a function this can read");
  });

  it("should name an option it could not read as a function, with what it saw", () => {
    // A name the file does not declare — imported, or built at runtime — stays unfollowed, and
    // the report says so rather than reading the option as one the project does not declare.
    const { config, tree } = projectWith(
      ["export default {", "  rewrites: fromSomewhereElse,", "};"].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { checked, unread } = buildRouteInterceptions(config, tree);
    expect(checked).toBe(1);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.subject).toBe("rewrites");
    expect(unread[0]?.reason).toContain("not written as a function this can read");
  });

  it("should name an option whose rules it could not read as a list", () => {
    // `CaliCastle/cali.so` computes its lists with `.flatMap()` over an imported manifest.
    const { config, tree } = projectWith(
      [
        "const legacy = manifest.entries.flatMap((entry) => entry.redirects);",
        "export default {",
        "  redirects: async () => legacy,",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { unread } = buildRouteInterceptions(config, tree);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.subject).toBe("redirects");
    expect(unread[0]?.reason).toContain("cannot read as a list of rules");
  });

  it("should report nothing unread where both options were read", () => {
    const { config, tree } = projectWith(
      [
        "export default {",
        "  async redirects() {",
        "    return [{ source: '/vieja', destination: '/nueva', permanent: true }];",
        "  },",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { checked, unread } = buildRouteInterceptions(config, tree);
    expect(checked).toBe(2);
    expect(unread).toEqual([]);
  });

  it("should follow a name to the rules it holds in the same file", () => {
    const { config, tree } = projectWith(
      [
        "const rules = [{ source: '/vieja', destination: '/nueva', permanent: true }];",
        "export default {",
        "  async redirects() {",
        "    return rules;",
        "  },",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    expect(buildRouteInterceptions(config, tree).findings).toHaveLength(1);
  });

  it("should follow a name to the rules a file of the project exports", () => {
    // `jpedroschmitz/typescript-nextjs-starter` keeps its redirects in their own module. Reading
    // only next.config.ts left the option stating nothing, and one of the two checks uncounted.
    const { config, tree } = projectWith(
      [
        "import { redirects } from './redirects';",
        "export default {",
        "  async redirects() {",
        "    return redirects;",
        "  },",
        "};",
      ].join("\n"),
      {
        "redirects.ts":
          "export const redirects = [{ source: '/vieja', destination: '/', permanent: true }];\n",
        "app/vieja/page.tsx": "export default () => null;",
      },
    );
    const { findings, checked } = buildRouteInterceptions(config, tree);
    expect(checked).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.routes[0]?.pattern).toBe("/vieja");
  });

  it("should let a name declared in the option's own body shadow the module's", () => {
    // Same name, two bindings. The local one is what the option returns, and it is not a list this
    // reader can read; taking the module's array would report rules the option never held.
    const { config, tree } = projectWith(
      [
        "const redirects = [{ source: '/vieja', destination: '/', permanent: true }];",
        "export default {",
        "  async redirects() {",
        "    const redirects = await load();",
        "    return redirects;",
        "  },",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings, checked } = buildRouteInterceptions(config, tree);
    expect(findings).toEqual([]);
    expect(checked).toBe(1);
  });

  it("should not follow a name to a file outside the project", () => {
    // This tool reads repositories it did not write. A specifier climbing out of the project names
    // something the project does not hold, and its strings would end up printed in the report.
    const { config, tree } = projectWith(
      [
        "import { redirects } from '../outside/rules';",
        "export default {",
        "  async redirects() {",
        "    return redirects;",
        "  },",
        "};",
      ].join("\n"),
      {
        // Written outside the project root on purpose: the file is there to be found, and the
        // reader must decline it anyway.
        "../outside/rules.ts":
          "export const redirects = [{ source: '/vieja', destination: '/', permanent: true }];\n",
        "app/vieja/page.tsx": "export default () => null;",
      },
    );
    const { findings, checked } = buildRouteInterceptions(config, tree);
    expect(findings).toEqual([]);
    expect(checked).toBe(1);
  });

  it("should not follow a name to a module the project does not hold", () => {
    // A bare specifier is a package, and what it exports is not this file's to state.
    const { config, tree } = projectWith(
      [
        "import { redirects } from 'some-package';",
        "export default {",
        "  async redirects() {",
        "    return redirects;",
        "  },",
        "};",
      ].join("\n"),
      { "app/vieja/page.tsx": "export default () => null;" },
    );
    const { findings, checked } = buildRouteInterceptions(config, tree);
    expect(findings).toEqual([]);
    expect(checked).toBe(1);
  });

  it("should say nothing about a rule matching a path nothing serves", () => {
    // The ordinary case, and what a redirect is for. A finding here would fire on every project.
    const { config, tree } = projectWith(
      [
        "export default {",
        "  async redirects() {",
        "    return [{ source: '/retirada', destination: '/', permanent: true }];",
        "  },",
        "};",
      ].join("\n"),
      { "app/page.tsx": "export default () => null;" },
    );
    expect(buildRouteInterceptions(config, tree).findings).toEqual([]);
  });

  it("should leave a pattern carrying parameters alone rather than approximating it", () => {
    const { config, tree } = projectWith(
      [
        "export default {",
        "  async redirects() {",
        "    return [{ source: '/:lang(es|en)/blog', destination: '/', permanent: true }];",
        "  },",
        "};",
      ].join("\n"),
      { "app/es/blog/page.tsx": "export default () => null;" },
    );
    expect(buildRouteInterceptions(config, tree).findings).toEqual([]);
  });

  it("should not count an option written in a shape it cannot read", () => {
    // Checked means examined. An option whose rules come from a helper was not examined, so it
    // is not counted — while its sibling, written nowhere, was: there were no rules to contradict
    // and that is an answer. One of the two, not both, and not neither.
    const { config, tree } = projectWith(
      ["export default {", "  redirects: rulesFrom(process.env.STAGE),", "};"].join("\n"),
      { "app/page.tsx": "export default () => null;" },
    );
    const { findings, checked } = buildRouteInterceptions(config, tree);
    expect(findings).toEqual([]);
    expect(checked).toBe(1);
  });

  it("should count the rules it could not read beside the ones it could", () => {
    const { config, tree } = projectWith(
      [
        "export default {",
        "  async redirects() {",
        "    return [",
        "      ...extra,",
        "      { source: '/favicon.png', destination: '/favicon.svg', permanent: true },",
        "    ];",
        "  },",
        "};",
      ].join("\n"),
      { "app/favicon.png/route.ts": HANDLER },
    );
    const [finding] = buildRouteInterceptions(config, tree).findings;
    expect(finding?.unread).toBe(1);
    expect(finding?.routes).toHaveLength(1);
  });

  it("should say nothing about a project with no configuration at all", () => {
    const { tree } = projectWith("export default {};", {
      "app/page.tsx": "export default () => null;",
    });
    const { checked, unread } = buildRouteInterceptions(undefined, tree);
    expect(checked).toBe(0);
    // A project that writes no configuration is not one this tool failed to read. Reporting it
    // here would attribute an ordinary state to a limit of the reader.
    expect(unread).toEqual([]);
  });

  it("should name each option where the configuration as a whole could not be read", () => {
    // The failure belongs to the export, not to either option, so the reason is the same for both.
    // Without the option's name the report prints one sentence twice and attributes it to nothing.
    const { config, tree } = projectWith("export default 42;", {
      "app/vieja/page.tsx": "export default () => null;",
    });
    const { checked, unread } = buildRouteInterceptions(config, tree);
    expect(checked).toBe(0);
    expect(unread.map((entry) => entry.subject)).toEqual(["redirects", "rewrites"]);
    expect(unread[0]?.reason).toBe(
      "'redirects' could not be read: default export is not an object literal",
    );
    expect(unread[1]?.reason).toBe(
      "'rewrites' could not be read: default export is not an object literal",
    );
  });
});

describe("a value the documentation says to write in by hand", () => {
  function projectWith(config: string, files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-prefix-"));
    writeFileSync(join(root, "next.config.ts"), config);
    for (const [relativePath, contents] of Object.entries(files)) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    mkdirSync(join(root, "app"), { recursive: true });
    return { config: readNextConfig(root), sources: scanSources(root) };
  }

  const IMAGE = (src: string) =>
    `import Image from 'next/image';\nexport default () => <Image src='${src}' alt='' />;`;

  it("should name an image source written without the configured prefix", () => {
    const { config, sources } = projectWith("export default { basePath: '/docs' };", {
      "app/page.tsx": IMAGE("/me.png"),
    });
    const { findings, checked } = buildUnprefixedAssets(config, sources, true);
    expect(checked).toBe(1);
    expect(findings[0]?.prefix).toBe("/docs");
    expect(findings[0]?.assets[0]?.value).toBe("/me.png");
    expect(findings[0]?.assets[0]?.file).toContain("page.tsx");
  });

  it("should say nothing where the source already carries the prefix", () => {
    const { config, sources } = projectWith("export default { basePath: '/docs' };", {
      "app/page.tsx": IMAGE("/docs/me.png"),
    });
    expect(buildUnprefixedAssets(config, sources, true).findings).toEqual([]);
  });

  it("should not treat a prefix that is only a name prefix as carried", () => {
    // `/docsmith/me.png` starts with the same characters and is a different path.
    const { config, sources } = projectWith("export default { basePath: '/docs' };", {
      "app/page.tsx": IMAGE("/docsmith/me.png"),
    });
    expect(buildUnprefixedAssets(config, sources, true).findings).toHaveLength(1);
  });

  it("should say nothing when the option is not configured", () => {
    const { config, sources } = projectWith("export default {};", {
      "app/page.tsx": IMAGE("/me.png"),
    });
    expect(buildUnprefixedAssets(config, sources, true).findings).toEqual([]);
  });

  it("should check nothing when the configured value cannot be read", () => {
    // A prefix this tool could not resolve cannot be compared against, so there is no check to
    // report — counting one would claim a comparison that never ran.
    const { config, sources } = projectWith("export default { basePath: prefix };", {
      "app/page.tsx": IMAGE("/me.png"),
    });
    expect(buildUnprefixedAssets(config, sources, true).checked).toBe(0);
  });

  it("should name the option when the reading that failed did not", () => {
    // The figure alone is the misleading part: a check that could not run lowers it and, without
    // this, says nothing else. The reader here describes the shape it saw and not the option it
    // was looking at, so the name has to be put back before the report prints the reason.
    const { config, sources } = projectWith("export default { basePath: prefix };", {
      "app/page.tsx": IMAGE("/me.png"),
    });
    expect(buildUnprefixedAssets(config, sources, true).unread).toEqual([
      {
        subject: "basePath",
        reason: "'basePath' could not be read: value is computed, not a literal",
      },
    ]);
  });

  it("should not name the option twice when the reading already named it", () => {
    // An option a spread may be carrying comes back already attributed. Prefixing that would
    // print the name twice in one sentence, which reads as a stutter rather than as an answer.
    const { config, sources } = projectWith("export default { ...carrier, distDir: 'out' };", {
      "app/page.tsx": IMAGE("/me.png"),
    });
    expect(buildUnprefixedAssets(config, sources, true).unread).toEqual([
      { subject: "basePath", reason: "'basePath' may come from a spread" },
    ]);
  });

  it("should report no failed reading where the value read cleanly", () => {
    // The channel exists to explain a figure that fell. A check that ran has nothing to explain,
    // and saying so here keeps a clean project from carrying a reason for something that worked.
    const { config, sources } = projectWith("export default { basePath: '/docs' };", {
      "app/page.tsx": IMAGE("/docs/me.png"),
    });
    const result = buildUnprefixedAssets(config, sources, true);
    expect(result.checked).toBe(1);
    expect(result.unread).toEqual([]);
  });

  it("should say nothing about a raw img element", () => {
    // The documented instruction names next/image. Extending it to a bare img would be this
    // tool's inference wearing the framework's words.
    const { config, sources } = projectWith("export default { basePath: '/docs' };", {
      "app/page.tsx": "export default () => <img src='/me.png' alt='' />;",
    });
    expect(buildUnprefixedAssets(config, sources, true).findings).toEqual([]);
  });

  it("should say nothing about a computed source", () => {
    const { config, sources } = projectWith("export default { basePath: '/docs' };", {
      "app/page.tsx":
        "import Image from 'next/image';\nconst src = '/me.png';\nexport default () => <Image src={src} alt='' />;",
    });
    expect(buildUnprefixedAssets(config, sources, true).findings).toEqual([]);
  });

  it("should say nothing where the installed documentation no longer gives the instruction", () => {
    const { config, sources } = projectWith("export default { basePath: '/docs' };", {
      "app/page.tsx": IMAGE("/me.png"),
    });
    const { findings, checked, unread } = buildUnprefixedAssets(config, sources, false);
    expect(findings).toEqual([]);
    expect(checked).toBe(0);
    // Not a reading that failed. An instruction the installed release no longer gives is a check
    // that does not apply, and attaching a reason to it would explain an absence nobody asked about.
    expect(unread).toEqual([]);
  });
});

describe("the reason a failed reading is printed with", () => {
  it("should prefix an option name onto a reason that carries none", () => {
    expect(reasonNaming("basePath", "value is computed, not a literal")).toBe(
      "'basePath' could not be read: value is computed, not a literal",
    );
  });

  it("should leave a reason that already names the option alone", () => {
    expect(reasonNaming("basePath", "'basePath' may come from a spread")).toBe(
      "'basePath' may come from a spread",
    );
  });

  it("should attribute a failure inherited from the configuration as a whole", () => {
    // The case that made the prefix necessary rather than tidy: when the file itself does not
    // resolve, every option resting on it inherits the same sentence. Printed bare, two checks
    // that could not run arrive as one sentence repeated, attributed to nothing.
    expect(reasonNaming("basePath", "default export is not an object literal")).toBe(
      "'basePath' could not be read: default export is not an object literal",
    );
  });
});

describe("modules the configuration names and the project does not hold", () => {
  function projectWith(config: string, files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-inject-"));
    writeFileSync(join(root, "next.config.ts"), config);
    for (const [relativePath, contents] of Object.entries(files)) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    return { config: readNextConfig(root), root };
  }

  const declaring = (...names: string[]) => resolved(new Set(names));

  it("should name a relative entry no file answers", () => {
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: ['./lib/analytics.js'] };",
      {},
    );
    const { findings, checked } = buildMissingModules(config, root, declaring());
    expect(checked).toBe(1);
    expect(findings[0]?.modules).toEqual([{ value: "./lib/analytics.js", as: "path" }]);
  });

  it("should say nothing when the file is there", () => {
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: ['./lib/analytics.js'] };",
      { "lib/analytics.js": "export {};" },
    );
    expect(buildMissingModules(config, root, declaring()).findings).toEqual([]);
  });

  it("should name an entry one branch of a conditional writes", () => {
    // The shape `voidcraft-labs/commcare-nova` writes, which reported 11 of 13 while the whole
    // reading stopped at the conditional. The module has to exist for the branch that names it,
    // so it is named whichever branch runs.
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: profiling ? ['./lib/profile.js'] : [] };",
      {},
    );
    const { findings, checked, unread } = buildMissingModules(config, root, declaring());
    expect(checked).toBe(1);
    expect(unread).toEqual([]);
    expect(findings[0]?.modules).toEqual([{ value: "./lib/profile.js", as: "path" }]);
  });

  it.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])(
    "should find an extensionless entry answered by a %s file",
    (extension) => {
      const { config, root } = projectWith(
        "export default { instrumentationClientInject: ['./lib/analytics'] };",
        { [`lib/analytics${extension}`]: "export {};" },
      );
      expect(buildMissingModules(config, root, declaring()).findings).toEqual([]);
    },
  );

  it("should name a bare entry the manifest does not declare and node_modules does not hold", () => {
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: ['analytics-sdk'] };",
      {},
    );
    const { findings } = buildMissingModules(config, root, declaring("react"));
    expect(findings[0]?.modules).toEqual([{ value: "analytics-sdk", as: "package" }]);
  });

  it("should say nothing about a bare entry the manifest declares", () => {
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: ['analytics-sdk'] };",
      {},
    );
    expect(buildMissingModules(config, root, declaring("analytics-sdk")).findings).toEqual([]);
  });

  it("should say nothing about a bare entry installed but not declared", () => {
    // A workspace package is there for the framework to import whatever the manifest says.
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: ['analytics-sdk'] };",
      { "node_modules/analytics-sdk/package.json": "{}" },
    );
    expect(buildMissingModules(config, root, declaring()).findings).toEqual([]);
  });

  it("should judge no bare entry when the manifest could not be read", () => {
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: ['analytics-sdk'] };",
      {},
    );
    const unreadable: Resolved<ReadonlySet<string>> = unresolved("no package.json");
    expect(buildMissingModules(config, root, unreadable).findings).toEqual([]);
  });

  it("should check nothing when the option is a call rather than a list", () => {
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: injections() };",
      {},
    );
    expect(buildMissingModules(config, root, declaring()).checked).toBe(0);
  });

  it("should name the option it could not read as a list", () => {
    // The reading was attempted on this option by name, so the figure it lowered is explainable.
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: injections() };",
      {},
    );
    const { unread } = buildMissingModules(config, root, declaring());
    expect(unread).toHaveLength(1);
    expect(unread[0]?.subject).toBe("instrumentationClientInject");
    expect(unread[0]?.reason).toContain("instrumentationClientInject");
  });

  it("should report no failed reading where the list read cleanly", () => {
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: ['./lib/a.js'] };",
      { "lib/a.js": "export default 1;" },
    );
    const { checked, unread } = buildMissingModules(config, root, declaring());
    expect(checked).toBe(1);
    expect(unread).toEqual([]);
  });

  it("should say nothing of a manifest it could not read, which is not this check's reading", () => {
    // The packages are read for a bare entry only. An unread manifest is stated where it happens,
    // and repeating it here would report two failures where the report already has one.
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: ['analytics-sdk'] };",
      {},
    );
    const unreadable: Resolved<ReadonlySet<string>> = unresolved("no package.json");
    expect(buildMissingModules(config, root, unreadable).unread).toEqual([]);
  });

  it("should carry the entries it could not read rather than drop them", () => {
    // A finding over one of two entries must not read as a finding over two.
    const { config, root } = projectWith(
      "export default { instrumentationClientInject: ['./lib/a.js', someOther] };",
      {},
    );
    const { findings } = buildMissingModules(config, root, declaring());
    expect(findings[0]?.modules).toHaveLength(1);
    expect(findings[0]?.unread).toBe(1);
  });

  it("should fire on the vendored fixture, which names a module it never held", () => {
    // `overconfigured-app` configures the option with a path taken from the documentation's
    // example. Nothing answers it, and the finding about that is correct.
    const root = fixtureRoot("overconfigured-app");
    const { findings } = buildMissingModules(readNextConfig(root), root, declaring());
    expect(findings[0]?.modules[0]?.value).toBe("./lib/analitica-cliente.js");
  });
});

describe("a setting the project's bundler never reads", () => {
  function configWith(source: string) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-scope-"));
    writeFileSync(join(root, "next.config.ts"), source);
    return readNextConfig(root);
  }
  const running = (...names: Bundler[]) => resolved(new Set(names));

  it("should name a webpack-only option on a project running Turbopack", () => {
    const config = configWith("export default { experimental: { useLightningcss: true } };");
    const { findings, checked } = buildBundlerScope(config, running("turbopack"));
    expect(checked).toBe(1);
    expect(findings[0]?.entry).toBe("config/next-config-js/useLightningcss");
    expect(findings[0]?.settings).toEqual([{ option: "useLightningcss", scope: "webpack" }]);
    expect(findings[0]?.running).toEqual(["turbopack"]);
  });

  it("should say nothing where a script runs the bundler the scope covers", () => {
    // Ignored by one command and read by another is not ignored.
    const config = configWith("export default { experimental: { useLightningcss: true } };");
    expect(buildBundlerScope(config, running("turbopack", "webpack")).findings).toEqual([]);
  });

  it.each(["turbopackChunking", "turbopackMemoryEviction", "turbopackLocalPostcssConfig"])(
    "should name %s on a project running webpack alone",
    (option) => {
      const config = configWith(`export default { experimental: { ${option}: true } };`);
      const { findings } = buildBundlerScope(config, running("webpack"));
      expect(findings[0]?.settings[0]?.option).toBe(option);
    },
  );

  it("should name the value rather than the option where the scope is on the value", () => {
    const config = configWith("export default { experimental: { cssChunking: 'graph' } };");
    const { findings } = buildBundlerScope(config, running("webpack"));
    expect(findings[0]?.settings).toEqual([
      { option: "cssChunking", value: "graph", scope: "turbopack" },
    ]);
  });

  it("should say nothing about a value scoped to the bundler in use", () => {
    const config = configWith("export default { experimental: { cssChunking: 'graph' } };");
    expect(buildBundlerScope(config, running("turbopack")).findings).toEqual([]);
  });

  it("should say nothing about the value both bundlers read", () => {
    const config = configWith("export default { experimental: { cssChunking: true } };");
    expect(buildBundlerScope(config, running("webpack")).findings).toEqual([]);
  });

  it("should check nothing where the bundler is unresolved", () => {
    // The absence of a declaration is not a declaration of the default.
    const config = configWith("export default { experimental: { useLightningcss: true } };");
    const unknown: Resolved<ReadonlySet<Bundler>> = unresolved("no script invokes the CLI");
    expect(buildBundlerScope(config, unknown).checked).toBe(0);
  });

  it("should name the bundlers as the reading that stopped it", () => {
    // Every row here is scoped to a bundler, so not knowing which ones run is this check's own
    // failure rather than one inherited from the configuration.
    const config = configWith("export default { experimental: { useLightningcss: true } };");
    const unknown: Resolved<ReadonlySet<Bundler>> = unresolved("no script invokes the CLI");
    const { unread } = buildBundlerScope(config, unknown);
    expect(unread).toEqual([
      {
        subject: "bundlers",
        reason:
          "the bundlers this project runs could not be read, so the options scoped to one were not checked",
      },
    ]);
  });

  it("should report no failed reading where a scoped option read cleanly", () => {
    const config = configWith("export default { experimental: { useLightningcss: true } };");
    const { checked, unread } = buildBundlerScope(config, running("turbopack"));
    expect(checked).toBe(1);
    expect(unread).toEqual([]);
  });

  it("should file each option on its own entry", () => {
    const config = configWith(
      "export default { experimental: { turbopackChunking: true, turbopackMemoryEviction: 'full' } };",
    );
    const { findings } = buildBundlerScope(config, running("webpack"));
    expect(findings.map((finding) => finding.entry).sort()).toEqual([
      "config/next-config-js/turbopackChunking",
      "config/next-config-js/turbopackMemoryEviction",
    ]);
  });

  it("should fire on the vendored fixture, which declares Turbopack and sets a webpack option", () => {
    const root = fixtureRoot("overconfigured-app");
    const { findings } = buildBundlerScope(readNextConfig(root), running("turbopack"));
    expect(findings.map((finding) => finding.entry)).toEqual([
      "config/next-config-js/useLightningcss",
    ]);
  });
});

describe("a combination the documentation names as failing", () => {
  function configWith(source: string) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-combo-"));
    writeFileSync(join(root, "next.config.ts"), source);
    return readNextConfig(root);
  }
  const OPT_OUT = "export default { experimental: { useTypeScriptCli: false } };";

  it("should name the opt-out under TypeScript 7", () => {
    const { findings, checked } = buildFailingCombination(configWith(OPT_OUT), resolved(7));
    expect(checked).toBe(1);
    expect(findings[0]?.entry).toBe("config/next-config-js/useTypeScriptCli");
    expect(findings[0]?.majorInstalled).toBe(7);
    expect(findings[0]?.consequence).toContain("next build exits");
  });

  it("should say nothing under TypeScript 6", () => {
    expect(buildFailingCombination(configWith(OPT_OUT), resolved(6)).findings).toEqual([]);
  });

  it("should say nothing where the project asks for the default", () => {
    // Configured is not enough: the failure the page names is the opt-out.
    const config = configWith("export default { experimental: { useTypeScriptCli: true } };");
    expect(buildFailingCombination(config, resolved(7)).findings).toEqual([]);
  });

  it("should say nothing where the option is absent", () => {
    expect(buildFailingCombination(configWith("export default {};"), resolved(7)).findings).toEqual(
      [],
    );
  });

  it("should say nothing where the value cannot be read", () => {
    const config = configWith("export default { experimental: { useTypeScriptCli: flag } };");
    expect(buildFailingCombination(config, resolved(7)).findings).toEqual([]);
  });

  it("should check nothing where the installed TypeScript is unresolved", () => {
    // A combination is not established by one of its parts.
    const unknown: Resolved<number> = unresolved("no installed typescript to read");
    expect(buildFailingCombination(configWith(OPT_OUT), unknown).checked).toBe(0);
  });

  it("should name the TypeScript it could not read, so the figure it lowers is accounted for", () => {
    // Measured on pdsk96/PdskWork, which reported eleven checked and no reason at all until this.
    const unknown: Resolved<number> = unresolved("no installed typescript to read");
    const { unread } = buildFailingCombination(configWith(OPT_OUT), unknown);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.subject).toBe("typescript");
    expect(unread[0]?.reason).toContain("could not be read");
  });

  it("should report the absence, never a fault in the project", () => {
    const unknown: Resolved<number> = unresolved("no installed typescript to read");
    const { unread } = buildFailingCombination(configWith(OPT_OUT), unknown);
    expect(unread[0]?.reason ?? "").not.toMatch(/should|must|invalid|wrong|error|fix/i);
  });

  it("should leave a cause above it to the level that states it", () => {
    // A configuration that does not resolve stops every constraint resting on it. Naming the
    // package here as well would report several failures where the project has one.
    const unknown: Resolved<number> = unresolved("no installed typescript to read");
    expect(buildFailingCombination(undefined, unknown).unread).toHaveLength(0);
    expect(buildFailingCombination(undefined, resolved(7)).unread).toHaveLength(0);
  });

  it("should say nothing on the fixture that opts out and declares no TypeScript", () => {
    const root = fixtureRoot("overconfigured-app");
    const unknown: Resolved<number> = unresolved("no installed typescript to read");
    expect(buildFailingCombination(readNextConfig(root), unknown).findings).toEqual([]);
  });

  it("should read the root spelling of the option too", () => {
    const config = configWith("export default { useTypeScriptCli: false };");
    expect(buildFailingCombination(config, resolved(8)).findings).toHaveLength(1);
  });
});

describe("an option whose prerequisite the project does not have", () => {
  function projectWith(source: string, files: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-prereq-"));
    writeFileSync(join(root, "next.config.ts"), source);
    for (const [relativePath, contents] of Object.entries(files)) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    return { config: readNextConfig(root), root };
  }
  /** The documented default, which is what a project saying nothing about extensions resolves. */
  const EXTENSIONS = resolved(DEFAULT_PAGE_EXTENSIONS);
  const LIMIT = "export default { experimental: { proxyClientMaxBodySize: '1mb' } };";
  const PROXY = "export function proxy() { return undefined; }";

  it("should name the limit set on a project with no proxy", () => {
    const { config, root } = projectWith(LIMIT);
    const { findings, checked } = buildAbsentPrerequisite(config, root, EXTENSIONS);
    expect(checked).toBe(1);
    expect(findings[0]?.entry).toBe("config/next-config-js/proxyClientMaxBodySize");
    expect(findings[0]?.needs).toContain("a proxy");
  });

  it.each([
    ["proxy.ts"],
    ["proxy.js"],
    ["src/proxy.ts"],
    ["src/proxy.js"],
    ["proxy.tsx"],
    ["src/proxy.tsx"],
    ["proxy.mjs"],
  ])("should say nothing where the project holds %s", (name) => {
    // The same names the catalog resolves the convention from, so a finding and that entry cannot
    // disagree about the same project. The reading was four literal names, and the three below it
    // did not cover were the disagreement: a `.tsx` proxy satisfied the entry and not this.
    const { config, root } = projectWith(LIMIT, { [name]: PROXY });
    expect(buildAbsentPrerequisite(config, root, EXTENSIONS).findings).toEqual([]);
  });

  it("should report the prerequisite absent where the extension is not one the project resolves", () => {
    const { config, root } = projectWith(LIMIT, { "proxy.tsx": PROXY });
    const narrowed = buildAbsentPrerequisite(config, root, resolved(["ts", "js"]));
    expect(narrowed.findings).toHaveLength(1);
  });

  it("should say nothing where the option is not configured", () => {
    const { config, root } = projectWith("export default {};");
    expect(buildAbsentPrerequisite(config, root, EXTENSIONS).findings).toEqual([]);
  });

  it("should not read the value, only whether it is written", () => {
    // Any bound on a buffer that is never allocated is the same finding.
    const { config, root } = projectWith(
      "export default { experimental: { proxyClientMaxBodySize: limit } };",
    );
    expect(buildAbsentPrerequisite(config, root, EXTENSIONS).findings).toHaveLength(1);
  });

  it("should read the root spelling too", () => {
    const { config, root } = projectWith("export default { proxyClientMaxBodySize: '2mb' };");
    expect(buildAbsentPrerequisite(config, root, EXTENSIONS).findings).toHaveLength(1);
  });

  it("should fire on the vendored fixture, which sets the limit and holds no proxy", () => {
    const root = fixtureRoot("overconfigured-app");
    const { findings } = buildAbsentPrerequisite(
      readNextConfig(root),
      root,
      resolved(DEFAULT_PAGE_EXTENSIONS),
    );
    expect(findings).toHaveLength(1);
  });
});

describe("a constraint counts only where it was checked", () => {
  /**
   * A configuration whose object cannot be reached: the default export names something the reader
   * cannot follow, so every value read from it is unresolved while the file itself exists.
   *
   * Three constraints used to count themselves checked here, because they asked whether a
   * configuration was present rather than whether the value they then read resolved. A parse
   * failure came back as checked and clean, which is the direction that hides a gap.
   */
  const unreadable = (): NextConfigSource => {
    const dir = mkdtempSync(join(tmpdir(), "next-coverage-unreadable-"));
    writeFileSync(join(dir, "next.config.ts"), "export default someoneElsesConfig;\n");
    const config = readNextConfig(dir);
    if (!config) throw new Error("expected the file to be found");
    expect(config.object.status).toBe("unresolved");
    return config;
  };

  it("should not count the bundler scope check", () => {
    const bundlers: Resolved<ReadonlySet<Bundler>> = resolved(new Set<Bundler>(["turbopack"]));
    expect(buildBundlerScope(unreadable(), bundlers).checked).toBe(0);
  });

  it("should not blame an option for the bundler scope check it could not run", () => {
    // The guard here asks whether any scoped option was readable, which cannot tell one written
    // in a shape this does not read from one the project never wrote. Naming an option would
    // describe writing the file does not contain, and the cause above it is stated where it
    // happens rather than once per constraint resting on it.
    const bundlers: Resolved<ReadonlySet<Bundler>> = resolved(new Set<Bundler>(["turbopack"]));
    expect(buildBundlerScope(unreadable(), bundlers).unread).toEqual([]);
  });

  it("should name the option the missing-module check read by name", () => {
    // The other side of the same rule: this reading asked for one option by name, so the reason
    // is attributable to it even when the failure came from the file as a whole.
    const root = mkdtempSync(join(tmpdir(), "next-coverage-inject-"));
    const { unread } = buildMissingModules(unreadable(), root, resolved(new Set<string>()));
    expect(unread).toHaveLength(1);
    expect(unread[0]?.subject).toBe("instrumentationClientInject");
    expect(unread[0]?.reason).toContain("'instrumentationClientInject' could not be read:");
  });

  it("should not count the failing combination check", () => {
    expect(buildFailingCombination(unreadable(), resolved(7)).checked).toBe(0);
  });

  it("should not count the absent prerequisite check", () => {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-prerequisite-"));
    expect(
      buildAbsentPrerequisite(unreadable(), root, resolved(DEFAULT_PAGE_EXTENSIONS)).checked,
    ).toBe(0);
  });

  it("should still count them where the configuration reads", () => {
    // The pair that makes the three above about the reading rather than about the constraint.
    const dir = mkdtempSync(join(tmpdir(), "next-coverage-readable-"));
    writeFileSync(join(dir, "next.config.ts"), "export default { typedRoutes: true };\n");
    const config = readNextConfig(dir);
    if (!config) throw new Error("expected the file to be found");
    const bundlers: Resolved<ReadonlySet<Bundler>> = resolved(new Set<Bundler>(["turbopack"]));
    expect(buildBundlerScope(config, bundlers).checked).toBe(1);
    expect(buildFailingCombination(config, resolved(7)).checked).toBe(1);
    expect(buildAbsentPrerequisite(config, dir, resolved(DEFAULT_PAGE_EXTENSIONS)).checked).toBe(1);
  });
});

describe("segments still exporting what the configuration removed", () => {
  function projectWith(config: string, files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-removed-"));
    writeFileSync(join(root, "next.config.ts"), config);
    for (const [relativePath, contents] of Object.entries(files)) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    const tree = buildRouteTree({
      appDirectory: join(root, "app"),
      pageExtensions: DEFAULT_PAGE_EXTENSIONS,
      isFlagEnabled: () => true,
    });
    return { config: readNextConfig(root), tree, sources: scanSources(root) };
  }

  const ON = "export default { cacheComponents: true };";
  const OFF = "export default { cacheComponents: false };";
  const PAGE = "export default function Page() { return null; }";

  it("should name each removed segment config a segment still exports", () => {
    // The documented list, one at a time: two of these carry values this tool does not read, which
    // is why the constraint rests on the export and not on what it is assigned.
    for (const [name, declaration] of [
      ["dynamic", "export const dynamic = 'force-static';"],
      ["dynamicParams", "export const dynamicParams = false;"],
      ["revalidate", "export const revalidate = 60;"],
      ["fetchCache", "export const fetchCache = 'default-cache';"],
    ]) {
      const { config, tree, sources } = projectWith(ON, {
        "app/page.tsx": `${declaration}\n${PAGE}`,
      });
      const { findings, checked } = buildSegmentConfigRemoved(config, tree, sources);
      expect(checked).toBe(1);
      expect(findings[0]?.entry).toBe(CACHE_COMPONENTS_ENTRY);
      expect(findings[0]?.segments.map((segment) => segment.exported)).toEqual([name]);
    }
  });

  it("should count the check where the option is on and no segment exports one", () => {
    const { config, tree, sources } = projectWith(ON, { "app/page.tsx": PAGE });
    const { findings, checked } = buildSegmentConfigRemoved(config, tree, sources);
    expect(checked).toBe(1);
    expect(findings).toEqual([]);
  });

  it("should say nothing where the option is off, because the removal has not happened", () => {
    const { config, tree, sources } = projectWith(OFF, {
      "app/page.tsx": `export const dynamic = 'force-static';\n${PAGE}`,
    });
    const { findings, checked } = buildSegmentConfigRemoved(config, tree, sources);
    expect(checked).toBe(1);
    expect(findings).toEqual([]);
  });

  it("should report the consequence, never a fault in the project", () => {
    const { config, tree, sources } = projectWith(ON, {
      "app/page.tsx": `export const dynamic = 'force-static';\n${PAGE}`,
    });
    const { findings } = buildSegmentConfigRemoved(config, tree, sources);
    expect(findings[0]?.consequence ?? "").not.toMatch(/should|must|invalid|wrong|error|fix/i);
  });

  it("should name the option it could not read, rather than only lowering the figure", () => {
    const { config, tree, sources } = projectWith("export default { cacheComponents: flag };", {
      "app/page.tsx": PAGE,
    });
    const { checked, unread } = buildSegmentConfigRemoved(config, tree, sources);
    expect(checked).toBe(0);
    expect(unread.map((entry) => entry.subject)).toEqual(["cacheComponents"]);
  });

  it("should leave a cause above it to the level that states it", () => {
    // A configuration that does not resolve stops every constraint resting on it. Naming the
    // option here as well would report several failures where the project has one.
    const { tree, sources } = projectWith(ON, { "app/page.tsx": PAGE });
    const { checked, unread } = buildSegmentConfigRemoved(undefined, tree, sources);
    expect(checked).toBe(0);
    expect(unread).toHaveLength(0);
  });
});
