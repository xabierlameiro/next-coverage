import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readNextConfig } from "../collect/config.js";
import {
  BASE_PATH_ENTRY,
  CLIENT_INJECT_ENTRY,
  TYPESCRIPT_CLI_ENTRY,
} from "../collect/constraints.js";
import type { SurfaceEntry } from "../collect/docs.js";
import { buildGraph } from "../collect/graph.js";
import type { BuildOutput, RenderingMode } from "../collect/output.js";
import { EMPTY_JOIN, NO_WEIGHTS } from "../collect/output.js";
import type { Bundler, ProjectContext } from "../collect/project.js";
import { resolveInstalledNext } from "../collect/project.js";
import { buildRouteTree } from "../collect/routes.js";
import { scanSources } from "../collect/sources.js";
import { DEFAULT_PAGE_EXTENSIONS, resolved, unresolved } from "../types.js";
import {
  alreadyHandles,
  CONFIG_PREDICATES,
  configOptionPredicate,
  DERIVED_OPTION_REASON,
  EXAMINATION_TRANCHES,
  MAPPED_PAGE_KEYS,
} from "./config.js";
import type { PredicateContext } from "./types.js";
import { reasonFor } from "./types.js";

const TYPED_ROUTES = "config/next-config-js/typedRoutes";

function project(
  files: Record<string, string>,
  declaredPackages: ProjectContext["declaredPackages"] = resolved(new Set<string>()),
): PredicateContext {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-cfg-"));
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
    // Resolved from the root rather than fixed: a test writing a minimal `next` under
    // node_modules gets a context that can read it, and one that writes none still gets undefined.
    installedNext: resolveInstalledNext(root),
    version: resolved("16.3.0"),
    config: readNextConfig(root),
    declaredPackages,
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
    domain: "config",
    title: id,
    relatedLinks: [],
    docPath: `/docs/${id}.md`,
    frontmatterFailed: false,
    docRelativePath: "",
    docUrl: "",
    adoptable: true,
  };
}

const predicate = (() => {
  const found = CONFIG_PREDICATES.find((p) => p.id === TYPED_ROUTES);
  if (!found) throw new Error("no typedRoutes predicate");
  return found;
})();

const entry = surface(TYPED_ROUTES);
const TS = { "tsconfig.json": "{}" };
const LINKING = {
  "app/page.tsx": "import Link from 'next/link';\nexport default () => <Link href='/a' />;",
};

function verdicts(context: PredicateContext) {
  return {
    used: predicate.detectUsed(context, entry),
    notApplicable: predicate.notApplicable?.(context, entry),
    wouldApply: predicate.wouldApply?.(context, entry),
  };
}

describe("typedRoutes", () => {
  it("should report the option as used when it is set", () => {
    const context = project({ ...TS, "next.config.ts": "export default { typedRoutes: true };" });
    const { used, wouldApply } = verdicts(context);
    expect(used.matched).toBe(true);
    expect(used.evidence[0]).toContain("next.config.ts");
    expect(wouldApply?.matched).toBe(false);
  });

  it("should report the experimental spelling as used too", () => {
    // Promoted out of experimental. A project that has not renamed the key is using the feature,
    // and telling it to adopt what it has would be the worst kind of suggestion.
    const context = project({
      ...TS,
      "next.config.ts": "export default { experimental: { typedRoutes: true } };",
    });
    expect(verdicts(context).used.matched).toBe(true);
  });

  it("should neither report used nor suggest when the config cannot be read", () => {
    const context = project({ ...TS, ...LINKING, "next.config.ts": "export default build();" });
    const { used, wouldApply } = verdicts(context);
    expect(used.matched).toBe(false);
    expect(wouldApply?.matched).toBe(false);
  });

  it("should rule the option out on a project without TypeScript", () => {
    const context = project({ ...LINKING, "next.config.js": "module.exports = {};" });
    const dismissed = verdicts(context).notApplicable;
    expect(dismissed?.matched).toBe(true);
    expect(dismissed?.note).toContain("TypeScript");
  });

  it("should suggest it to a TypeScript project that links without it", () => {
    const context = project({ ...TS, ...LINKING, "next.config.ts": "export default {};" });
    const { notApplicable, wouldApply } = verdicts(context);
    expect(notApplicable?.matched).toBe(false);
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence).toHaveLength(1);
    expect(wouldApply?.evidence[0]).toContain("app/page.tsx");
  });

  it("should not suggest it to a project that links nowhere", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default {};",
      "app/page.tsx": "export default () => null;",
    });
    expect(verdicts(context).wouldApply?.matched).toBe(false);
  });

  it("should not suggest it when only tests import the link component", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default {};",
      "app/page.test.tsx": "import Link from 'next/link';\nit('renders', () => {});",
    });
    expect(verdicts(context).wouldApply?.matched).toBe(false);
  });
});

describe("derived config option detection", () => {
  const option = (name: string) => surface(`config/next-config-js/${name}`);

  function derived(name: string) {
    const built = configOptionPredicate(option(name));
    if (!built) throw new Error(`no derived predicate for ${name}`);
    return built;
  }

  it("should report an option the project sets, whatever its value", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default { serverExternalPackages: ['pg'] };",
    });
    const verdict = derived("serverExternalPackages").detectUsed(
      context,
      option("serverExternalPackages"),
    );
    expect(verdict.matched).toBe(true);
    expect(verdict.evidence[0]).toContain("next.config.ts");
  });

  it("should report an option written as a method", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default { async redirects() { return []; } };",
    });
    expect(derived("redirects").detectUsed(context, option("redirects")).matched).toBe(true);
  });

  it("should find an option under the experimental prefix", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default { experimental: { taint: true } };",
    });
    expect(derived("taint").detectUsed(context, option("taint")).matched).toBe(true);
  });

  it("should report neither used nor a suggestion for an absent or unreadable option", () => {
    const absent = project({ ...TS, "next.config.ts": "export default { images: {} };" });
    expect(derived("basePath").detectUsed(absent, option("basePath")).matched).toBe(false);
    const unreadable = project({ ...TS, "next.config.ts": "export default build();" });
    expect(derived("basePath").detectUsed(unreadable, option("basePath")).matched).toBe(false);
    expect(derived("basePath").wouldApply).toBeUndefined();
  });

  it("should build a predicate for an option this code never names", () => {
    const built = configOptionPredicate(option("somethingNextAddsLater"));
    expect(built?.id).toBe("config/next-config-js/somethingNextAddsLater");
    expect(built?.wouldApply).toBeUndefined();
  });

  it("should build nothing for a page outside the option directory", () => {
    expect(configOptionPredicate(surface("config/eslint"))).toBeUndefined();
    expect(configOptionPredicate(surface("functions/cacheTag"))).toBeUndefined();
    expect(configOptionPredicate(surface("config/next-config-js"))).toBeUndefined();
  });

  it("should leave typedRoutes to its authored predicate", () => {
    // The authored one carries the heuristic and the TypeScript prerequisite; the derived one
    // would answer used and nothing else. The catalog prefers authored, and this proves the
    // derived generator does not quietly become the only answer.
    expect(configOptionPredicate(option("typedRoutes"))?.wouldApply).toBeUndefined();
    expect(predicate.wouldApply).toBeDefined();
    expect(predicate.notApplicable).toBeDefined();
  });
});

describe("reactCompiler", () => {
  const RC = "config/next-config-js/reactCompiler";
  const authored = (() => {
    const found = CONFIG_PREDICATES.find((p) => p.id === RC);
    if (!found) throw new Error("no reactCompiler predicate");
    return found;
  })();
  const rc = surface(RC);
  const MEMO = "import { useMemo } from 'react';\nexport default () => useMemo(() => 1, []);";

  it("should report it as used when set, under either spelling", () => {
    for (const config of [
      "export default { reactCompiler: true };",
      "export default { experimental: { reactCompiler: true } };",
      "export default { reactCompiler: { compilationMode: 'annotation' } };",
    ]) {
      const context = project({ ...TS, "next.config.ts": config, "app/page.tsx": MEMO });
      expect(authored.detectUsed(context, rc).matched).toBe(true);
      // Set and still memoizing by hand is not a finding: the compiler is already on.
      expect(authored.wouldApply?.(context, rc).matched).toBe(false);
    }
  });

  it("should suggest it to a project that memoizes by hand without it", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default {};",
      "app/page.tsx": MEMO,
    });
    const verdict = authored.wouldApply?.(context, rc);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence[0]).toContain("app/page.tsx");
    expect(verdict?.note).toContain("memoize by hand");
  });

  it("should find useCallback as well as useMemo", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default {};",
      "app/page.tsx":
        "import { useCallback } from 'react';\nexport default () => useCallback(() => {}, []);",
    });
    expect(authored.wouldApply?.(context, rc).matched).toBe(true);
  });

  it("should say nothing to a project that does not memoize by hand", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default {};",
      "app/page.tsx": "export default () => null;",
    });
    expect(authored.wouldApply?.(context, rc).matched).toBe(false);
  });

  it("should not count memoization that only happens in tests", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default {};",
      "app/page.test.tsx": MEMO,
    });
    expect(authored.wouldApply?.(context, rc).matched).toBe(false);
  });

  it("should neither report used nor suggest when the config cannot be read", () => {
    const context = project({
      ...TS,
      "next.config.ts": "export default build();",
      "app/page.tsx": MEMO,
    });
    expect(authored.detectUsed(context, rc).matched).toBe(false);
    expect(authored.wouldApply?.(context, rc).matched).toBe(false);
  });
});

describe("the integration pages", () => {
  const setOf = (id: string) => {
    const found = CONFIG_PREDICATES.find((p) => p.id === id);
    if (!found) throw new Error(`no ${id} predicate`);
    return found;
  };
  const eslint = setOf("config/eslint");
  const typescript = setOf("config/typescript");

  it("should read the ESLint integration from the manifest, not from the configuration", () => {
    const context = project({}, resolved(new Set(["eslint-config-next"])));
    const verdict = eslint.detectUsed(context, surface("config/eslint"));
    expect(verdict.matched).toBe(true);
    expect(verdict.evidence).toEqual([join(context.project.root, "package.json")]);
  });

  it("should accept the plugin on its own, for a project wiring the rules itself", () => {
    const context = project({}, resolved(new Set(["@next/eslint-plugin-next"])));
    expect(eslint.detectUsed(context, surface("config/eslint")).matched).toBe(true);
  });

  it("should not report the ESLint integration when the manifest declares neither", () => {
    const context = project({}, resolved(new Set(["eslint"])));
    expect(eslint.detectUsed(context, surface("config/eslint")).matched).toBe(false);
  });

  it("should stay silent when the manifest could not be read", () => {
    const context = project({}, unresolved("no manifest"));
    // An unreadable manifest declares nothing and knows nothing; reading it as empty would
    // report a project that does use the integration as not using it.
    expect(eslint.detectUsed(context, surface("config/eslint")).matched).toBe(false);
  });

  it("should read TypeScript from the tsconfig rather than from the configuration", () => {
    const context = project(TS);
    const verdict = typescript.detectUsed(context, surface("config/typescript"));
    expect(verdict.matched).toBe(true);
    expect(verdict.evidence).toEqual([join(context.project.root, "tsconfig.json")]);
  });

  it("should not report TypeScript for a project with no tsconfig", () => {
    expect(typescript.detectUsed(project({}), surface("config/typescript")).matched).toBe(false);
  });

  it("should suggest neither, and say why", () => {
    for (const set of [eslint, typescript]) {
      expect(set.wouldApply).toBeUndefined();
      expect(set.wouldApplyStrict).toBeUndefined();
      expect(set.noSuggestion?.kind).toBe("abstained");
    }
  });
});

describe("the options examined one at a time", () => {
  // An option leaves this list when its refusal is reopened: the entry then carries the
  // measurement in `reopenedFrom` and a condition beside it, which the reopening tests assert.
  const EXAMINED = [
    "config/next-config-js/optimizePackageImports",
    "config/next-config-js/serverExternalPackages",
    "config/next-config-js/images",
    "config/next-config-js/transpilePackages",
    "config/next-config-js/pageExtensions",
    "config/next-config-js/output",
    "config/next-config-js/sassOptions",
    "config/next-config-js/mdxRs",
    "config/next-config-js/webpack",
    "config/next-config-js/turbopack",
    "config/next-config-js/redirects",
    "config/next-config-js/rewrites",
    "config/next-config-js/headers",
  ] as const;

  it("should be authored rather than left to the derived predicate", () => {
    for (const id of EXAMINED) {
      const authored = CONFIG_PREDICATES.find((predicate) => predicate.id === id);
      expect(authored, id).toBeDefined();
    }
  });

  /**
   * The measurement survives the conversion, which is what this asserts. An examined option holds
   * its condition and outcome in `noSuggestion` while it refuses and in `reopenedFrom` once a
   * condition replaces the refusal; either way it holds both, and neither way does it fall back to
   * the group reason. Reading only the first would have gone quiet as entries converted.
   */
  it("should each record the condition it tried and the outcome it measured", () => {
    for (const id of EXAMINED) {
      const authored = CONFIG_PREDICATES.find((predicate) => predicate.id === id);
      const reason = authored?.noSuggestion;
      const reopened = authored?.reopenedFrom;
      if (reason === undefined) {
        expect(reopened, id).toBeDefined();
        expect(reopened?.condition, id).not.toBe("");
        expect(reopened?.outcome, id).not.toBe("");
        continue;
      }
      expect(reason.kind, id).toBe("examined");
      if (reason.kind !== "examined") continue;
      expect(reason.condition, id).not.toBe("");
      expect(reason.outcome, id).not.toBe("");
      expect(reasonFor(reason), id).not.toBe(DERIVED_OPTION_REASON);
    }
  });

  it("should still be derivable, so an unauthored option keeps its group reason", () => {
    // The derived predicate answers for the pages nobody examined. Losing that would leave
    // every other option page with no predicate at all.
    const derived = configOptionPredicate({
      id: "config/next-config-js/basePath",
      domain: "config",
      title: "basePath",
      adoptable: true,
    } as SurfaceEntry);
    expect(derived?.noSuggestion).toMatchObject({
      kind: "abstained",
      why: DERIVED_OPTION_REASON,
    });
  });

  it("should keep answering used-detection for the options it took over", () => {
    const context = project({
      "next.config.ts": [
        "export default {",
        "  optimizePackageImports: ['lucide-react'],",
        "  serverExternalPackages: ['unpdf'],",
        "  images: { remotePatterns: [] },",
        "  transpilePackages: ['@acme/ui'],",
        "  pageExtensions: ['ts', 'tsx'],",
        "  env: { NEXT_PUBLIC_SHA: 'abc' },",
        "  output: 'standalone',",
        "  sassOptions: {},",
        "  mdxRs: true,",
        "  webpack: () => ({}),",
        "  turbopack: {},",
        "  async redirects() { return []; },",
        "  async rewrites() { return []; },",
        "  async headers() { return []; },",
        "};",
      ].join("\n"),
    });
    for (const id of EXAMINED) {
      const authored = CONFIG_PREDICATES.find((predicate) => predicate.id === id);
      const verdict = authored?.detectUsed(context, undefined as never);
      expect(verdict?.matched, id).toBe(true);
    }
  });

  it("should detect the experimental spelling of the two promoted options", () => {
    const context = project({
      "next.config.ts": [
        "export default {",
        "  experimental: {",
        "    optimizePackageImports: ['lucide-react'],",
        "    serverComponentsExternalPackages: ['unpdf'],",
        "  },",
        "};",
      ].join("\n"),
    });
    for (const id of EXAMINED.slice(0, 2)) {
      const authored = CONFIG_PREDICATES.find((predicate) => predicate.id === id);
      expect(authored?.detectUsed(context, undefined as never).matched, id).toBe(true);
    }
  });
});

describe("code the configuration leaves inert", () => {
  const CACHE_LIFE = "config/next-config-js/cacheLife";

  /**
   * A project carrying just enough of an installed `next` for the profile reader to work. The
   * vendored fixtures have no `node_modules`, so this condition cannot be proven there — the list
   * comes back unresolved and the predicate correctly goes quiet.
   */
  function projectWithInstalledNext(files: Record<string, string>): PredicateContext {
    return project({
      ...files,
      "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.3.0" }),
      // The shape the reader anchors on: profile names, each followed by its own object, and a
      // sibling key after the closing brace so the balanced-brace cut is exercised too.
      "node_modules/next/dist/esm/server/config-shared.js": [
        "export const config = {",
        "    cacheLife: {",
        "        default: { stale: undefined, revalidate: 900, expire: 1 },",
        "        seconds: { stale: 30, revalidate: 1, expire: 60 },",
        "        minutes: { stale: 300, revalidate: 60, expire: 3600 },",
        "        hours: { stale: 300, revalidate: 3600, expire: 86400 },",
        "    },",
        "    cacheHandlers: { default: undefined },",
        "};",
      ].join("\n"),
    });
  }

  it("should report a cache scope naming a profile nothing defines", () => {
    const context = projectWithInstalledNext({
      "next.config.ts": "export default { cacheComponents: true };",
      "app/informes/page.tsx": [
        "'use cache';",
        "import { cacheLife } from 'next/cache';",
        "export default async function P() { cacheLife('informes-diarios'); return null; }",
      ].join("\n"),
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === CACHE_LIFE);
    const verdict = predicate?.wouldApply?.(context, undefined as never);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("informes-diarios");
  });

  it("should say nothing about a built-in profile", () => {
    const context = projectWithInstalledNext({
      "next.config.ts": "export default { cacheComponents: true };",
      "app/informes/page.tsx": [
        "'use cache';",
        "import { cacheLife } from 'next/cache';",
        "export default async function P() { cacheLife('hours'); return null; }",
      ].join("\n"),
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === CACHE_LIFE);
    expect(predicate?.wouldApply?.(context, undefined as never).matched).toBe(false);
  });

  it("should say nothing when the configuration defines the profile", () => {
    const context = projectWithInstalledNext({
      "next.config.ts":
        "export default { cacheComponents: true, cacheLife: { informes: { revalidate: 60 } } };",
      "app/informes/page.tsx": [
        "'use cache';",
        "import { cacheLife } from 'next/cache';",
        "export default async function P() { cacheLife('informes'); return null; }",
      ].join("\n"),
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === CACHE_LIFE);
    expect(predicate?.wouldApply?.(context, undefined as never).matched).toBe(false);
  });

  it("should read a profile name the file declares as a constant", () => {
    // Not a guess: the file declares the name once, as a const with a literal, and never assigns
    // to it again. The condition used to be silent here because the value was unread, which is a
    // different silence from having looked.
    const context = projectWithInstalledNext({
      "next.config.ts": "export default { cacheComponents: true };",
      "app/informes/page.tsx": [
        "'use cache';",
        "import { cacheLife } from 'next/cache';",
        "const perfil = 'informes-diarios';",
        "export default async function P() { cacheLife(perfil); return null; }",
      ].join("\n"),
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === CACHE_LIFE);
    const verdict = predicate?.wouldApply?.(context, undefined as never);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("informes-diarios");
  });

  it("should say nothing when the profile name is built at runtime", () => {
    // The silence that remains, and the one the condition needs: a value nobody wrote down is
    // exactly where guessing would invent a finding.
    const context = projectWithInstalledNext({
      "next.config.ts": "export default { cacheComponents: true };",
      "app/informes/page.tsx": [
        "'use cache';",
        "import { cacheLife } from 'next/cache';",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the scanned source, not our code
        "export default async function P(tipo) { cacheLife(`informes-${tipo}`); return null; }",
      ].join("\n"),
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === CACHE_LIFE);
    expect(predicate?.wouldApply?.(context, undefined as never).matched).toBe(false);
  });

  it("should go quiet where the built-in profiles cannot be read", () => {
    // No installed next: the reader is unresolved, and a condition resting on it reports nothing
    // rather than treating every named profile as undefined.
    const context = project({
      "next.config.ts": "export default { cacheComponents: true };",
      "app/informes/page.tsx": [
        "'use cache';",
        "import { cacheLife } from 'next/cache';",
        "export default async function P() { cacheLife('informes-diarios'); return null; }",
      ].join("\n"),
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === CACHE_LIFE);
    expect(predicate?.wouldApply?.(context, undefined as never).matched).toBe(false);
  });
});

describe("the order the options are examined in", () => {
  const OPTION_PREFIX = "config/next-config-js/";
  const authored = new Set(
    CONFIG_PREDICATES.filter((entry) => entry.id.startsWith(OPTION_PREFIX)).map((entry) =>
      entry.id.slice(OPTION_PREFIX.length),
    ),
  );

  it("should place an option in at most one tranche", () => {
    const named = EXAMINATION_TRANCHES.flat();
    expect(new Set(named).size).toBe(named.length);
  });

  it("should name no option that has already been examined", () => {
    // A tranche entry is a claim that nobody has looked at the option. An authored one has been
    // looked at, so leaving it in a tranche would promise work that is already done.
    const overlap = EXAMINATION_TRANCHES.flat().filter((option) => authored.has(option));
    expect(overlap).toEqual([]);
  });

  it("should name options the derived predicate actually covers", () => {
    for (const option of EXAMINATION_TRANCHES.flat()) {
      const entry = {
        id: `${OPTION_PREFIX}${option}`,
        domain: "config",
        title: option,
        relatedLinks: [],
        docPath: `/docs/${option}.md`,
        frontmatterFailed: false,
        docRelativePath: "",
        docUrl: "",
        adoptable: true,
      } satisfies SurfaceEntry;
      const silence = configOptionPredicate(entry)?.noSuggestion;
      expect(silence && reasonFor(silence)).toBe(DERIVED_OPTION_REASON);
    }
  });
});

describe("the sentence an examined option reads as", () => {
  it("should compose the reason from the condition and the outcome", () => {
    const reason = reasonFor({
      kind: "examined",
      measuredAgainst: "16.3.0",
      failed: "condition",
      condition: "a declared dependency carrying a native binary, absent from the list",
      outcome: "the one package it matched is already on Next's own default list",
    });
    // The release is part of the sentence, because a refusal is a claim about what a page states
    // and a reader weighing one is owed which release it was read against.
    expect(reason).toBe(
      "measured: a declared dependency carrying a native binary, absent from the list, " +
        "and the one package it matched is already on Next's own default list " +
        "(read against Next.js 16.3.0)",
    );
  });

  it("should leave the other kinds reading as they were written", () => {
    // An abstention names its release too: it claims the code carries nothing arguing for the API,
    // which is a claim about what the API's page describes.
    expect(
      reasonFor({ kind: "abstained", why: "a product decision", measuredAgainst: "16.3.0" }),
    ).toBe("a product decision (read against Next.js 16.3.0)");
    expect(reasonFor({ kind: "unwritten", why: "nobody has written it" })).toBe(
      "nobody has written it",
    );
  });

  it("should give a delegation no reason of its own, because it points at one", () => {
    expect(
      reasonFor({ kind: "delegated", to: "file-conventions/proxy", measuredAgainst: "16.3.0" }),
    ).toBeUndefined();
  });
});

describe("the extensions a project's conventions are written in", () => {
  const PAGE_EXTENSIONS = "config/next-config-js/pageExtensions";

  it("should report the option as used when the configuration sets it", () => {
    const context = project({
      "next.config.ts": "export default { pageExtensions: ['ts', 'tsx', 'mdx'] };",
      "app/page.tsx": "export default function P() { return null; }",
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === PAGE_EXTENSIONS);
    expect(predicate?.detectUsed(context, undefined as never).matched).toBe(true);
  });

  it("should hold no verdict when the configuration leaves it out", () => {
    const context = project({
      "next.config.ts": "export default { poweredByHeader: false };",
      "app/page.tsx": "export default function P() { return null; }",
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === PAGE_EXTENSIONS);
    expect(predicate?.detectUsed(context, undefined as never).matched).toBe(false);
  });

  it("should suggest nothing, recording what refused the condition", () => {
    // The condition read well and matched a content template of placeholder frontmatter whose
    // name collides with a convention. What refused it is that an unrecognised extension is
    // where those two look alike, which is a property of the shape rather than of what was read.
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === PAGE_EXTENSIONS);
    expect(predicate?.wouldApply).toBeUndefined();
    const silence = predicate?.noSuggestion;
    expect(silence?.kind).toBe("examined");
    if (silence?.kind !== "examined") return;
    expect(silence.outcome).toContain("a data file and a miswritten convention look alike");
  });
});

const envPredicate = () => CONFIG_PREDICATES.find((e) => e.id === "config/next-config-js/env");

describe("the keys a build injects, and the shape it is built for", () => {
  it("should report env as used when the configuration declares keys", () => {
    const context = project({
      "next.config.ts": "export default { env: { NEXT_PUBLIC_SHA: 'abc' } };",
    });
    const predicate = CONFIG_PREDICATES.find((e) => e.id === "config/next-config-js/env");
    expect(predicate?.detectUsed(context, undefined as never).matched).toBe(true);
  });

  /**
   * The refusal read the option against nothing reading the key, and that is the constraint's
   * business. What the condition reports is the other half its page states: a key set here is in
   * the browser bundle whatever reads it. So the entry suggests now, under `--strict`, and carries
   * the refusal that says why it is withheld.
   */
  it("should suggest under strict while carrying the refusal it replaced", () => {
    const predicate = CONFIG_PREDICATES.find((e) => e.id === "config/next-config-js/env");
    expect(predicate?.wouldApply).toBeUndefined();
    expect(predicate?.wouldApplyStrict).toBeDefined();
    expect(predicate?.noSuggestion).toBeUndefined();
    expect(predicate?.reopenedFrom?.outcome).toContain("reported as a constraint on the option");
  });

  /**
   * Two readings, two tiers. `detectUsed` reads one config key and the condition asks which modules
   * the client closure holds, and the entry says both — it used to declare `GRAFO` for the set
   * because there was nowhere else to put the condition's.
   */
  it("should declare the tier each of its readings costs", () => {
    expect(envPredicate()?.cost).toBe("FS");
    expect(envPredicate()?.conditionCost).toBe("GRAFO");
  });

  it("should report a key only server modules read by name", () => {
    const context = project({
      "next.config.ts": "export default { env: { BUILD_SHA: 'abc' } };",
      "app/page.tsx": "export default () => process.env.BUILD_SHA;",
    });
    const verdict = envPredicate()?.wouldApplyStrict?.(context, undefined as never);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.note).toContain("BUILD_SHA");
  });

  it("should say nothing about a key a client module reads", () => {
    const context = project({
      "next.config.ts": "export default { env: { BUILD_SHA: 'abc' } };",
      "app/page.tsx": "'use client';\nexport default () => process.env.BUILD_SHA;",
    });
    expect(envPredicate()?.wouldApplyStrict?.(context, undefined as never).matched).toBe(false);
  });

  /**
   * The near-miss that decides the condition's reach. A project validating its environment into an
   * exported object reads `env.KEY` everywhere and `process.env.KEY` in one module, so a key that
   * looks unread may be read in the browser on every route. Judging it would be naming a key on
   * the strength of not having looked.
   */
  it("should say nothing about a key nothing reads by name", () => {
    const context = project({
      "next.config.ts": "export default { env: { BUILD_SHA: 'abc' } };",
      "app/page.tsx": "export default () => 'no environment read here';",
    });
    expect(envPredicate()?.wouldApplyStrict?.(context, undefined as never).matched).toBe(false);
  });

  it("should say nothing where the option declares no keys", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx": "export default () => process.env.BUILD_SHA;",
    });
    expect(envPredicate()?.wouldApplyStrict?.(context, undefined as never).matched).toBe(false);
  });

  it("should report output as used whichever value it carries", () => {
    const context = project({ "next.config.ts": "export default { output: 'standalone' };" });
    const predicate = CONFIG_PREDICATES.find((e) => e.id === "config/next-config-js/output");
    expect(predicate?.detectUsed(context, undefined as never).matched).toBe(true);
  });

  it("should carry the error the export already gives into the reopening", () => {
    // The documented rule is real, and the framework enforces it: a static export beside code it
    // does not support is a build that fails. A finding on it would duplicate that error, which
    // is the shape `adapterPath` was refused for too. What the reopening answers is the refusal's
    // other half — that with the option unset there is nothing to read — and the first half
    // travels with it rather than being deleted by it.
    const predicate = CONFIG_PREDICATES.find((e) => e.id === "config/next-config-js/output");
    expect(predicate?.noSuggestion).toBeUndefined();
    expect(predicate?.wouldApply).toBeUndefined();
    expect(predicate?.wouldApplyStrict).toBeDefined();
    expect(predicate?.reopenedFrom?.outcome).toContain("a build the framework refuses");
  });
});

describe("importing from a URL", () => {
  const URL_IMPORTS = "config/next-config-js/urlImports";

  it("should suggest the option to a project whose imports resolve nowhere without it", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx": [
        "import confetti from 'https://esm.sh/canvas-confetti';",
        "export default function P() { return confetti ? null : null; }",
      ].join("\n"),
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === URL_IMPORTS);
    const verdict = predicate?.wouldApply?.(context, undefined as never);
    expect(verdict?.matched).toBe(true);
    expect(verdict?.evidence[0]).toContain("app/page.tsx");
    expect(verdict?.note).toContain("resolves only with this option on");
  });

  it("should say nothing about a project importing only packages and paths", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx": "import Link from 'next/link';\nexport default () => <Link href='/a' />;",
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === URL_IMPORTS);
    expect(predicate?.wouldApply?.(context, undefined as never).matched).toBe(false);
  });

  it("should report the option as used under either spelling", () => {
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === URL_IMPORTS);
    for (const contents of [
      "export default { urlImports: ['https://esm.sh'] };",
      "export default { experimental: { urlImports: ['https://esm.sh'] } };",
    ]) {
      const context = project({ "next.config.ts": contents });
      expect(predicate?.detectUsed(context, undefined as never).matched, contents).toBe(true);
    }
  });

  it("should not suggest it from a test file alone", () => {
    // The same rule every other condition follows: production code is what argues for an API.
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.test.tsx": "import x from 'https://esm.sh/x';\nit('runs', () => x);",
    });
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === URL_IMPORTS);
    expect(predicate?.wouldApply?.(context, undefined as never).matched).toBe(false);
  });
});

describe("the two options whose input this tool does not hold", () => {
  /**
   * The refusal called the input missing, and the reopening found it: the convention walk pushes
   * every file it declines onto `colocated`, so a `.scss` name beside a route was readable all
   * along. The refusal travels with the condition rather than being deleted by it.
   */
  it("should reopen the Sass condition on the names the route tree already held", () => {
    const predicate = CONFIG_PREDICATES.find((e) => e.id === "config/next-config-js/sassOptions");
    expect(predicate?.noSuggestion).toBeUndefined();
    expect(predicate?.wouldApply).toBeUndefined();
    expect(predicate?.wouldApplyStrict).toBeDefined();
    expect(predicate?.reopenedFrom?.outcome).toContain(".scss");
  });

  it("should reopen the MDX compiler condition on the integration its page names", () => {
    const predicate = CONFIG_PREDICATES.find((e) => e.id === "config/next-config-js/mdxRs");
    expect(predicate?.noSuggestion).toBeUndefined();
    expect(predicate?.wouldApplyStrict).toBeDefined();
    expect(predicate?.reopenedFrom?.outcome).toContain("performance choice");
  });

  /**
   * A project can keep `.mdx` files and compile none of them through the framework — declaring
   * `next-mdx-remote` builds MDX at run time instead. A file says the project has MDX; only the
   * integration says the framework compiles it.
   */
  it("should say nothing about MDX files the framework does not compile", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "package.json": JSON.stringify({
        name: "x",
        dependencies: { next: "16.3.0", "next-mdx-remote": "5.0.0" },
        scripts: { build: "next build" },
      }),
      "app/post.mdx": "# a post\n",
      "app/page.tsx": "export default () => null;",
    });
    const predicate = CONFIG_PREDICATES.find((e) => e.id === "config/next-config-js/mdxRs");
    expect(predicate?.wouldApplyStrict?.(context, undefined as never).matched).toBe(false);
  });
});

/**
 * The two build output options converted to a condition that need no build. Neither fires on any
 * referenced project — no project sets `distDir` and none versions a custom server — so these cases
 * are the only evidence either condition works, and the record says so rather than counting them as
 * coverage.
 */
describe("the build directory a project renamed and did not ignore", () => {
  const DIST_DIR = "config/next-config-js/distDir";

  function verdict(files: Record<string, string>) {
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === DIST_DIR);
    return predicate?.wouldApplyStrict?.(project(files), undefined as never);
  }

  it("should report a renamed build directory the ignore file does not exclude", () => {
    const found = verdict({
      "next.config.ts": "export default { distDir: 'build' };",
      ".gitignore": "node_modules\n/.next/\n",
    });
    expect(found?.matched).toBe(true);
    expect(found?.note).toContain("build");
    expect(found?.gain).toContain("not excluded from version control");
  });

  it("should say nothing where the option is unset", () => {
    expect(
      verdict({ "next.config.ts": "export default {};", ".gitignore": "/.next/\n" })?.matched,
    ).toBe(false);
  });

  it("should say nothing where the configured name is ignored", () => {
    expect(
      verdict({
        "next.config.ts": "export default { distDir: 'build' };",
        ".gitignore": "/.next/\nbuild\n",
      })?.matched,
    ).toBe(false);
  });

  it("should say nothing where the configured value is not a literal", () => {
    expect(
      verdict({
        "next.config.ts": "export default { distDir: process.env.DIST ?? 'build' };",
        ".gitignore": "/.next/\n",
      })?.matched,
    ).toBe(false);
  });

  it("should say nothing where the ignore file excludes neither", () => {
    // A project versioning its build output whatever it is called is a real consequence and it is
    // not this option's: an entry must not become the place a neighbouring finding is filed.
    expect(
      verdict({
        "next.config.ts": "export default { distDir: 'build' };",
        ".gitignore": "node_modules\n",
      })?.matched,
    ).toBe(false);
  });

  it("should carry the refusal it replaced", () => {
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === DIST_DIR);
    expect(predicate?.noSuggestion).toBeUndefined();
    expect(predicate?.wouldApply).toBeUndefined();
    expect(predicate?.reopenedFrom?.outcome).toContain("the scan boundary excludes");
  });
});

describe("the custom server that already compresses", () => {
  const COMPRESS = "config/next-config-js/compress";

  function verdict(files: Record<string, string>) {
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === COMPRESS);
    return predicate?.wouldApplyStrict?.(project(files), undefined as never);
  }

  const SERVER = [
    "import next from 'next';",
    "import compression from 'compression';",
    "export const app = next({ dev: false });",
    "export const middleware = compression();",
  ].join("\n");

  it("should report a versioned server running the framework behind compression", () => {
    const found = verdict({ "next.config.ts": "export default {};", "server.ts": SERVER });
    expect(found?.matched).toBe(true);
    expect(found?.gain).toContain("inert in that arrangement");
  });

  it("should say nothing about a module that only imports the middleware", () => {
    expect(
      verdict({
        "next.config.ts": "export default {};",
        "middleware-chain.ts":
          "import compression from 'compression';\nexport default compression();",
      })?.matched,
    ).toBe(false);
  });

  it("should say nothing about a module that only imports the framework", () => {
    expect(
      verdict({
        "next.config.ts": "export default {};",
        "server.ts": "import next from 'next';\nexport const app = next({ dev: false });",
      })?.matched,
    ).toBe(false);
  });

  it("should not read a server written as a test", () => {
    expect(
      verdict({ "next.config.ts": "export default {};", "server.test.ts": SERVER })?.matched,
    ).toBe(false);
  });

  it("should carry the refusal it replaced", () => {
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === COMPRESS);
    expect(predicate?.noSuggestion).toBeUndefined();
    expect(predicate?.wouldApply).toBeUndefined();
    expect(predicate?.reopenedFrom?.outcome).toContain("inert behind a custom server");
  });
});

/**
 * The three build output options converted to a condition that read the build.
 *
 * None fires on any referenced project, and the reasons differ: every project holds route handlers,
 * nobody enables production source maps, and the one project configuring `generateBuildId` has a
 * stale build. So these cases are the only evidence the three conditions work at all, and the
 * silence in each is asserted to be the reader's refusal rather than a false negative.
 */
describe("the conditions that read what the build recorded", () => {
  function buildOf(overrides: Partial<BuildOutput> = {}): BuildOutput {
    return {
      buildId: "sNXYWbNcAWHUOIqeekIyN",
      routeUrls: new Map(),
      prerendered: new Map(),
      dynamicRoutes: new Map(),
      unreadableEntries: 0,
      weights: NO_WEIGHTS,
      browserSourceMaps: { count: 0, bytes: 0 },
      ...overrides,
    };
  }

  function withBuild(
    files: Record<string, string>,
    build: PredicateContext["build"],
  ): PredicateContext {
    return { ...project(files), build };
  }

  function verdictFor(id: string, context: PredicateContext) {
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
    return predicate?.wouldApplyStrict?.(context, undefined as never);
  }

  const OUTPUT = "config/next-config-js/output";
  const BUILD_ID = "config/next-config-js/generateBuildId";
  const SOURCE_MAPS = "config/next-config-js/productionBrowserSourceMaps";

  const PRERENDERED = (urls: readonly string[], mode: RenderingMode = "STATIC") =>
    new Map(urls.map((url) => [url, { url, mode }]));

  describe("output", () => {
    const STATIC_TREE = {
      "next.config.ts": "export default {};",
      "app/page.tsx": "export default () => null;",
      "app/about/page.tsx": "export default () => null;",
    };

    it("should report a build that is already what an export produces", () => {
      const found = verdictFor(
        OUTPUT,
        withBuild(
          STATIC_TREE,
          resolved(
            buildOf({
              routeUrls: new Map([
                ["/page", "/"],
                ["/about/page", "/about"],
              ]),
              prerendered: PRERENDERED(["/", "/about"]),
            }),
          ),
        ),
      );
      expect(found?.matched).toBe(true);
      expect(found?.note).toContain("2 routes");
    });

    it("should say nothing where a route was not prerendered", () => {
      expect(
        verdictFor(
          OUTPUT,
          withBuild(
            STATIC_TREE,
            resolved(
              buildOf({
                routeUrls: new Map([
                  ["/page", "/"],
                  ["/about/page", "/about"],
                ]),
                prerendered: PRERENDERED(["/"]),
              }),
            ),
          ),
        )?.matched,
      ).toBe(false);
    });

    it("should not collapse a partially static route into either mode", () => {
      expect(
        verdictFor(
          OUTPUT,
          withBuild(
            STATIC_TREE,
            resolved(
              buildOf({
                routeUrls: new Map([["/page", "/"]]),
                prerendered: PRERENDERED(["/"], "PARTIALLY_STATIC"),
              }),
            ),
          ),
        )?.matched,
      ).toBe(false);
    });

    it("should say nothing where the tree holds a route handler", () => {
      expect(
        verdictFor(
          OUTPUT,
          withBuild(
            {
              "next.config.ts": "export default {};",
              "app/page.tsx": "export default () => null;",
              "app/api/route.ts": "export function GET() { return new Response('') }",
            },
            resolved(
              buildOf({
                routeUrls: new Map([["/page", "/"]]),
                prerendered: PRERENDERED(["/"]),
              }),
            ),
          ),
        )?.matched,
      ).toBe(false);
    });

    it("should say nothing where no build was read", () => {
      expect(
        verdictFor(OUTPUT, withBuild(STATIC_TREE, unresolved("the build is stale")))?.matched,
      ).toBe(false);
    });
  });

  describe("generateBuildId", () => {
    const CONFIGURED = {
      "next.config.ts": "export default { generateBuildId: async () => 'x' };",
      "app/page.tsx": "export default () => null;",
    };

    it("should report an identity that carries a number", () => {
      const found = verdictFor(
        BUILD_ID,
        withBuild(CONFIGURED, resolved(buildOf({ buildId: "local-1788740546846" }))),
      );
      expect(found?.matched).toBe(true);
      expect(found?.note).toContain("local-1788740546846");
    });

    it("should say nothing about an identity that does not", () => {
      expect(
        verdictFor(
          BUILD_ID,
          withBuild(CONFIGURED, resolved(buildOf({ buildId: "ieXpRf09Q7qq4jVb5fORe" }))),
        )?.matched,
      ).toBe(false);
    });

    it("should say nothing where the option is unset", () => {
      expect(
        verdictFor(
          BUILD_ID,
          withBuild(
            {
              "next.config.ts": "export default {};",
              "app/page.tsx": "export default () => null;",
            },
            resolved(buildOf({ buildId: "local-1788740546846" })),
          ),
        )?.matched,
      ).toBe(false);
    });

    it("should say nothing where no build was read", () => {
      expect(
        verdictFor(BUILD_ID, withBuild(CONFIGURED, unresolved("the build is stale")))?.matched,
      ).toBe(false);
    });
  });

  describe("productionBrowserSourceMaps", () => {
    const ENABLED = {
      "next.config.ts": "export default { productionBrowserSourceMaps: true };",
      "app/page.tsx": "export default () => null;",
    };

    it("should report the maps the build emitted", () => {
      const found = verdictFor(
        SOURCE_MAPS,
        withBuild(ENABLED, resolved(buildOf({ browserSourceMaps: { count: 3, bytes: 3 * 1024 } }))),
      );
      expect(found?.matched).toBe(true);
      expect(found?.note).toContain("3 browser source maps");
      expect(found?.note).toContain("3 KiB");
    });

    it("should say nothing where the build emitted none", () => {
      expect(verdictFor(SOURCE_MAPS, withBuild(ENABLED, resolved(buildOf())))?.matched).toBe(false);
    });

    /**
     * The silence that has to be the reader's. A directory nobody could open is not a build that
     * emitted nothing, and reporting the second about the first would be a finding about the tool.
     */
    it("should say nothing where the chunk directory could not be read", () => {
      expect(
        verdictFor(
          SOURCE_MAPS,
          withBuild(
            ENABLED,
            resolved(
              buildOf({
                browserSourceMaps: { count: 0, bytes: 0, reason: ".next holds no static/chunks" },
              }),
            ),
          ),
        )?.matched,
      ).toBe(false);
    });

    it("should say nothing where the option is off", () => {
      expect(
        verdictFor(
          SOURCE_MAPS,
          withBuild(
            {
              "next.config.ts": "export default {};",
              "app/page.tsx": "export default () => null;",
            },
            resolved(buildOf({ browserSourceMaps: { count: 3, bytes: 3072 } })),
          ),
        )?.matched,
      ).toBe(false);
    });

    it("should say nothing where no build was read", () => {
      expect(
        verdictFor(SOURCE_MAPS, withBuild(ENABLED, unresolved("the build is stale")))?.matched,
      ).toBe(false);
    });
  });

  /**
   * The entry answers without a build and its condition does not, and both are declared. `cost` is
   * the used detection's — what every run pays — and `conditionCost` is the reading only `--strict`
   * asks for. Declaring the second on the set is what stops a stale build from taking
   * `generateBuildId` out of *Used*.
   */
  it("should declare the used detection and the condition apart", () => {
    for (const id of [OUTPUT, BUILD_ID, SOURCE_MAPS]) {
      const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
      expect(predicate?.cost, id).toBe("FS");
      expect(predicate?.conditionCost, id).toBe("BUILD");
    }
  });

  it("should carry the refusal each replaced", () => {
    for (const [id, fragment] of [
      [OUTPUT, "a build the framework refuses"],
      [BUILD_ID, "a property of the deployment"],
      [SOURCE_MAPS, "nothing in a source tree settles"],
    ] as const) {
      const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
      expect(predicate?.noSuggestion, id).toBeUndefined();
      expect(predicate?.wouldApply, id).toBeUndefined();
      expect(predicate?.reopenedFrom?.outcome, id).toContain(fragment);
    }
  });
});

/**
 * The ten build output options examined and left refused.
 *
 * The family converted five and kept ten, and the split is argued rather than a
 * shortfall. What this holds is that the ten were not quietly converted afterwards: each keeps the
 * condition and outcome it recorded, byte for byte, and carries no condition of any preset. A later
 * change reopening one has to edit this list, which is the point.
 */
describe("the build-output refusals that were kept", () => {
  const KEPT = [
    ["assetPrefix", "a deployment fact"],
    ["deploymentId", "not in the repository"],
    ["outputHashSalt", "not in the repository"],
    ["supportsImmutableAssets", "not in the repository"],
    ["generateEtags", "CDN"],
    ["crossOrigin", "next/script"],
    ["adapterPath", "an adapter"],
    ["basePath", "documented-constraints"],
    ["useTypeScriptCli", "documented-constraints"],
  ] as const;

  it.each(KEPT.map(([option]) => option))("should keep %s refused and unconverted", (option) => {
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === `config/next-config-js/${option}`,
    );
    const silence = predicate?.noSuggestion;
    expect(silence?.kind, option).toBe("examined");
    if (silence?.kind !== "examined") return;
    expect(silence.condition.length, option).toBeGreaterThan(0);
    expect(silence.outcome.length, option).toBeGreaterThan(0);
    expect(predicate?.wouldApply, option).toBeUndefined();
    expect(predicate?.wouldApplyStrict, option).toBeUndefined();
    expect(predicate?.reopenedFrom, option).toBeUndefined();
  });

  /**
   * Two of the ten do argue, through the constraint channel rather than through a predicate: their
   * pages instruct, and an instruction a project fails to follow is readable. Neither gained a
   * second finding, which is what would make the same fact arrive twice.
   */
  it("should leave the two that argue through constraints arguing there and only there", () => {
    for (const id of [BASE_PATH_ENTRY, TYPESCRIPT_CLI_ENTRY]) {
      const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
      expect(predicate?.wouldApply, id).toBeUndefined();
      expect(predicate?.wouldApplyStrict, id).toBeUndefined();
    }
  });
});

const TRAILING_SLASH = "config/next-config-js/trailingSlash";

function trailingSlashVerdict(context: PredicateContext) {
  const found = CONFIG_PREDICATES.find((entry) => entry.id === TRAILING_SLASH);
  if (!found) throw new Error("no trailingSlash predicate");
  return {
    used: found.detectUsed(context, surface(TRAILING_SLASH)),
    wouldApply: found.wouldApply?.(context, surface(TRAILING_SLASH)),
  };
}

describe("trailingSlash", () => {
  it("should suggest it where a link ends in a slash and the option is unset", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx":
        "import Link from 'next/link';\nexport default () => <Link href='/about/' />;",
    });
    const { used, wouldApply } = trailingSlashVerdict(context);
    expect(used.matched).toBe(false);
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence[0]).toContain("page.tsx");
  });

  it("should read a bare anchor the same way a Link is read", () => {
    // The redirect is a property of the URL, so keying on the component would report the same
    // href in one file and not in another for a reason that has nothing to do with the redirect.
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx": "export default () => <a href='/docs/'>docs</a>;",
    });
    expect(trailingSlashVerdict(context).wouldApply?.matched).toBe(true);
  });

  it("should say nothing where every link is slashless", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx": "import Link from 'next/link';\nexport default () => <Link href='/about' />;",
    });
    expect(trailingSlashVerdict(context).wouldApply?.matched).toBe(false);
  });

  it("should not read the root path as a trailing slash", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx": "export default () => <a href='/'>home</a>;",
    });
    expect(trailingSlashVerdict(context).wouldApply?.matched).toBe(false);
  });

  it("should leave URLs belonging to another origin alone", () => {
    // A protocol-relative URL starts with a slash and ends with one, and is somebody else's site.
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx":
        "export default () => <><a href='https://example.com/'>a</a><a href='//cdn.example.com/'>b</a></>;",
    });
    expect(trailingSlashVerdict(context).wouldApply?.matched).toBe(false);
  });

  it("should not read a computed href", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx": "const to = '/about/';\nexport default () => <a href={to}>x</a>;",
    });
    expect(trailingSlashVerdict(context).wouldApply?.matched).toBe(false);
  });

  it("should not argue from a test file", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.test.tsx": "it('links', () => <a href='/about/'>x</a>);",
    });
    expect(trailingSlashVerdict(context).wouldApply?.matched).toBe(false);
  });

  it("should report the option as used and suggest nothing when it is set", () => {
    const context = project({
      "next.config.ts": "export default { trailingSlash: true };",
      "app/page.tsx": "export default () => <a href='/about/'>x</a>;",
    });
    const { used, wouldApply } = trailingSlashVerdict(context);
    expect(used.matched).toBe(true);
    expect(wouldApply?.matched).toBe(false);
  });

  it("should stay quiet when the configuration cannot be read", () => {
    // Unresolved is not unset: an option nobody could look for is not one that is missing.
    const context = project({
      "next.config.ts": "export default withPlugin({ trailingSlash: flag });",
      "app/page.tsx": "export default () => <a href='/about/'>x</a>;",
    });
    expect(trailingSlashVerdict(context).wouldApply?.matched).toBe(false);
  });
});

describe("the tranche whose effect lives outside the source tree", () => {
  const REFUSED = [
    ["compress", "custom"],
    ["generateEtags", "CDN"],
    ["distDir", "does not version"],
    ["expireTime", "a deployment fact"],
    ["reactMaxHeadersLength", "build"],
  ] as const;

  it.each(REFUSED)("should carry the outcome that refused %s", (option, fragment) => {
    // Three still refuse. `compress` and `distDir` are reopened behind `--strict` — one on the
    // server the refusal said was absent, the other on the ignore file it overlooked — and both
    // carry the same outcome into `reopenedFrom`, which is what this asserts survived.
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === `config/next-config-js/${option}`,
    );
    const silence = predicate?.noSuggestion;
    const carried = silence?.kind === "examined" ? silence : predicate?.reopenedFrom;
    expect(carried, option).toBeDefined();
    expect(carried?.outcome).toContain(fragment);
    expect(predicate?.wouldApply).toBeUndefined();
  });

  it.each(REFUSED)("should still report %s as used where it is configured", (option) => {
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === `config/next-config-js/${option}`,
    );
    const context = project({ "next.config.ts": `export default { ${option}: true };` });
    expect(predicate?.detectUsed(context, surface(`config/next-config-js/${option}`)).matched).toBe(
      true,
    );
  });
});

describe("the tranche whose values only mean something against how the project is served", () => {
  const DEPLOYMENT = [
    ["assetPrefix", "not readable from source"],
    ["deploymentId", "does not read it"],
    ["outputHashSalt", "without changing sources"],
    ["crossOrigin", "next/script"],
  ] as const;

  it.each(DEPLOYMENT)("should refuse %s with the outcome that refused it", (option, fragment) => {
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === `config/next-config-js/${option}`,
    );
    const silence = predicate?.noSuggestion;
    expect(silence?.kind).toBe("examined");
    if (silence?.kind !== "examined") return;
    expect(silence.outcome).toContain(fragment);
    expect(predicate?.wouldApply).toBeUndefined();
  });

  it("should refuse basePath as a suggestion and leave it to the constraint channel", () => {
    // The option carries a finding, but it is one about a configured value: nothing in a source
    // tree asks to be served from a subpath, so there is nothing to suggest.
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === BASE_PATH_ENTRY);
    expect(predicate?.wouldApply).toBeUndefined();
    const silence = predicate?.noSuggestion;
    expect(silence?.kind).toBe("examined");
    if (silence?.kind !== "examined") return;
    expect(silence.outcome).toContain("reported as a constraint");
  });

  it.each([...DEPLOYMENT.map(([option]) => option), "basePath"])(
    "should still report %s as used where it is configured",
    (option) => {
      const id = `config/next-config-js/${option}`;
      const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
      const value = option === "basePath" ? "'/docs'" : "'x'";
      const context = project({ "next.config.ts": `export default { ${option}: ${value} };` });
      expect(predicate?.detectUsed(context, surface(id)).matched).toBe(true);
    },
  );
});

describe("the tranche that named a module the project has to contain", () => {
  const MODULE_PATHS = [["adapterPath", "require.resolve"]] as const;

  it.each(MODULE_PATHS)("should refuse %s with the outcome that refused it", (option, fragment) => {
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === `config/next-config-js/${option}`,
    );
    const silence = predicate?.noSuggestion;
    expect(silence?.kind).toBe("examined");
    if (silence?.kind !== "examined") return;
    expect(silence.outcome).toContain(fragment);
    expect(predicate?.wouldApply).toBeUndefined();
  });

  // `cacheHandlers` left this tranche's refusals when it was reopened against its own page. The
  // measurement did not leave with it: it is carried on the predicate that replaced it, and the
  // assertion moved to the reopening's own block below.
  it("should carry the cacheHandlers refusal onto the condition that replaced it", () => {
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === "config/next-config-js/cacheHandlers",
    );
    expect(predicate?.noSuggestion).toBeUndefined();
    expect(predicate?.wouldApply).toBeUndefined();
    expect(predicate?.reopenedFrom?.outcome).toContain("in-memory LRU");
  });

  describe("the in-memory cache a custom handler replaces", () => {
    const MAX_MEMORY = "config/next-config-js/cacheMaxMemorySize";
    const argues = (config: string) => {
      const predicate = CONFIG_PREDICATES.find((entry) => entry.id === MAX_MEMORY);
      const context = project({ "next.config.ts": config });
      return predicate?.wouldApply?.(context, surface(MAX_MEMORY));
    };

    it("should argue where a handler is configured and the size is not", () => {
      const verdict = argues("export default { cacheHandler: './h.js' };");
      expect(verdict?.matched).toBe(true);
      expect(verdict?.note).toContain("50 MB");
    });

    it("should argue where the size is set to something other than zero", () => {
      // Presence is not the reading. A project running the default beside a handler is the case
      // the page is written about, and treating any value as done would call it settled.
      expect(
        argues("export default { cacheHandler: './h.js', cacheMaxMemorySize: 50 };")?.matched,
      ).toBe(true);
    });

    it("should stay silent where the size is already zero", () => {
      expect(
        argues("export default { cacheHandler: './h.js', cacheMaxMemorySize: 0 };")?.matched,
      ).toBe(false);
    });

    // The two keys differ by one character and mean opposite things here: the plural's own page
    // says its handler manages its own memory and this option no longer applies to it, so a
    // project registering it is one the documentation asks nothing of.
    it("should stay silent where the handlers are registered through the plural option", () => {
      expect(argues("export default { cacheHandlers: { default: './h.js' } };")?.matched).toBe(
        false,
      );
    });

    it("should stay silent where no handler is configured at all", () => {
      expect(argues("export default { cacheMaxMemorySize: 268435456 };")?.matched).toBe(false);
    });
  });

  it("should leave instrumentationClientInject to the constraint channel", () => {
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === CLIENT_INJECT_ENTRY);
    expect(predicate?.wouldApply).toBeUndefined();
    const silence = predicate?.noSuggestion;
    expect(silence?.kind).toBe("examined");
    if (silence?.kind !== "examined") return;
    expect(silence.outcome).toContain("reported as a constraint");
  });

  it.each(["adapterPath", "cacheHandlers", "instrumentationClientInject"])(
    "should report %s as used where it is configured",
    (option) => {
      const id = `config/next-config-js/${option}`;
      const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
      const value = option === "cacheHandlers" ? "{ default: './h.js' }" : "['./m.js']";
      const context = project({ "next.config.ts": `export default { ${option}: ${value} };` });
      expect(predicate?.detectUsed(context, surface(id)).matched).toBe(true);
    },
  );
});

const HMR_CACHE = "config/next-config-js/serverComponentsHmrCache";

function hmrVerdict(context: PredicateContext) {
  const found = CONFIG_PREDICATES.find((entry) => entry.id === HMR_CACHE);
  if (!found) throw new Error("no serverComponentsHmrCache predicate");
  return {
    used: found.detectUsed(context, surface(HMR_CACHE)),
    wouldApply: found.wouldApply?.(context, surface(HMR_CACHE)),
  };
}

const UNCACHED = "export async function load() { return fetch('/api', { cache: 'no-store' }); }";

describe("serverComponentsHmrCache", () => {
  it("should suggest it where a server file fetches uncached and the option is unset", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx":
        "import { load } from './data';\nexport default async () => { await load(); return null; };",
      "app/data.ts": UNCACHED,
    });
    const { used, wouldApply } = hmrVerdict(context);
    expect(used.matched).toBe(false);
    expect(wouldApply?.matched).toBe(true);
    expect(wouldApply?.evidence[0]).toContain("data.ts");
  });

  // The development cache sits in front of fetches Next.js runs. A module nothing the framework
  // loads reaches — a Lambda handler's helper on the project this was measured on — is not one.
  it("should say nothing about a fetch nothing the framework runs reaches", () => {
    const context = project({ "next.config.ts": "export default {};", "lib/data.ts": UNCACHED });
    expect(hmrVerdict(context).wouldApply?.matched).toBe(false);
  });

  it("should say nothing about a fetch in the client closure", () => {
    // It runs in the browser, where no cache of the framework's stands between it and the network.
    const context = project({
      "next.config.ts": "export default {};",
      "app/page.tsx": "'use client';\nimport { load } from './data';\nexport default () => load();",
      "app/data.ts": UNCACHED,
    });
    expect(hmrVerdict(context).wouldApply?.matched).toBe(false);
  });

  it("should say nothing where the fetch is cached", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/data.ts":
        "export async function load() { return fetch('/api', { cache: 'force-cache' }); }",
    });
    expect(hmrVerdict(context).wouldApply?.matched).toBe(false);
  });

  it("should say nothing where the cache option is computed", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/data.ts":
        "const mode = 'no-store';\nexport async function load() { return fetch('/api', { cache: mode }); }",
    });
    expect(hmrVerdict(context).wouldApply?.matched).toBe(false);
  });

  it("should not argue from a test file", () => {
    const context = project({
      "next.config.ts": "export default {};",
      "app/data.test.ts": UNCACHED,
    });
    expect(hmrVerdict(context).wouldApply?.matched).toBe(false);
  });

  it.each(["false", "true"])(
    "should report the option as used and suggest nothing when set to %s",
    (value) => {
      const context = project({
        "next.config.ts": `export default { experimental: { serverComponentsHmrCache: ${value} } };`,
        "app/data.ts": UNCACHED,
      });
      const { used, wouldApply } = hmrVerdict(context);
      expect(used.matched).toBe(true);
      expect(wouldApply?.matched).toBe(false);
    },
  );
});

describe("the tranche named for where its options run", () => {
  const DEV_ONLY = [
    ["allowedDevOrigins", "how somebody runs it"],
    ["devIndicators", "somebody's screen"],
    ["onDemandEntries", "how a person navigates"],
  ] as const;

  it.each(DEV_ONLY)("should refuse %s with the outcome that refused it", (option, fragment) => {
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === `config/next-config-js/${option}`,
    );
    const silence = predicate?.noSuggestion;
    expect(silence?.kind).toBe("examined");
    if (silence?.kind !== "examined") return;
    expect(silence.outcome).toContain(fragment);
    expect(predicate?.wouldApply).toBeUndefined();
  });

  it.each(DEV_ONLY.map(([option]) => option))(
    "should report %s as used where it is configured",
    (option) => {
      const id = `config/next-config-js/${option}`;
      const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
      const context = project({ "next.config.ts": `export default { ${option}: ['x'] };` });
      expect(predicate?.detectUsed(context, surface(id)).matched).toBe(true);
    },
  );
});

describe("the tranche readable only once the bundler is known", () => {
  const BUNDLER_SCOPED = [
    "cssChunking",
    "turbopackChunking",
    "turbopackMemoryEviction",
    "turbopackLocalPostcssConfig",
    "useLightningcss",
  ];

  /**
   * All five shared one outcome — what can be said is a constraint on a configured value rather
   * than a suggestion — and all five are reopened behind `--strict` while carrying it. The
   * assertion is that the copied outcome travelled with each condition rather than being deleted
   * by it, and that none of them reached the default preset.
   */
  it.each(BUNDLER_SCOPED)("should reopen %s while carrying its refusal", (option) => {
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === `config/next-config-js/${option}`,
    );
    expect(predicate?.wouldApply).toBeUndefined();
    expect(predicate?.wouldApplyStrict).toBeDefined();
    expect(predicate?.noSuggestion).toBeUndefined();
    expect(predicate?.reopenedFrom?.outcome).toContain("reported as a constraint");
  });

  it.each(BUNDLER_SCOPED)("should report %s as used where it is configured", (option) => {
    const id = `config/next-config-js/${option}`;
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
    const context = project({
      "next.config.ts": `export default { experimental: { ${option}: true } };`,
    });
    expect(predicate?.detectUsed(context, surface(id)).matched).toBe(true);
  });
});

describe("the tranche about what reaches the browser", () => {
  const TRADES = [
    ["productionBrowserSourceMaps", "nothing in a source tree settles"],
    ["supportsImmutableAssets", "not in the repository"],
    ["inlineCss", "the build produces"],
    ["prefetchInlining", "property of a network"],
  ] as const;

  it.each(TRADES)("should carry the outcome that refused %s", (option, fragment) => {
    // Four trades the framework offers both sides of, where what decides the side is outside the
    // source. Three still refuse; `inlineCss` is reopened behind `--strict` on the proxy its own
    // page names for the size it cannot read, and carries the same outcome into `reopenedFrom`.
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === `config/next-config-js/${option}`,
    );
    const silence = predicate?.noSuggestion;
    const carried = silence?.kind === "examined" ? silence : predicate?.reopenedFrom;
    expect(carried, option).toBeDefined();
    expect(carried?.outcome).toContain(fragment);
    expect((carried?.condition ?? "").length).toBeGreaterThan(0);
    expect(predicate?.wouldApply).toBeUndefined();
  });

  // Two of the four are root keys and two live under `experimental`, which is what each page's
  // own example writes — asking for the wrong one would test the spelling rather than the entry.
  it.each([
    ["productionBrowserSourceMaps", "root"],
    ["supportsImmutableAssets", "root"],
    ["inlineCss", "experimental"],
    ["prefetchInlining", "experimental"],
  ] as const)("should report %s as used where it is configured", (option, container) => {
    const id = `config/next-config-js/${option}`;
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
    const written =
      container === "root"
        ? `export default { ${option}: true };`
        : `export default { experimental: { ${option}: true } };`;
    const context = project({ "next.config.ts": written });
    expect(predicate?.detectUsed(context, surface(id)).matched).toBe(true);
  });
});

describe("the two options with no neighbour", () => {
  it("should record that the derivation already answers exportPathMap", () => {
    // Its page carries `version: legacy`, and a legacy entry is filed as not applicable before any
    // condition runs. The reason says so rather than offering a second opinion beside it.
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === "config/next-config-js/exportPathMap",
    );
    expect(predicate?.wouldApply).toBeUndefined();
    const silence = predicate?.noSuggestion;
    expect(silence?.kind).toBe("examined");
    if (silence?.kind !== "examined") return;
    expect(silence.outcome).toContain("legacy");
  });

  it("should leave useTypeScriptCli to the constraint channel", () => {
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === "config/next-config-js/useTypeScriptCli",
    );
    expect(predicate?.wouldApply).toBeUndefined();
    const silence = predicate?.noSuggestion;
    expect(silence?.kind).toBe("examined");
    if (silence?.kind !== "examined") return;
    expect(silence.outcome).toContain("reported as a constraint");
  });

  it.each([
    ["exportPathMap", "root"],
    ["useTypeScriptCli", "experimental"],
  ] as const)("should report %s as used where it is configured", (option, container) => {
    const id = `config/next-config-js/${option}`;
    const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
    const written =
      container === "root"
        ? `export default { ${option}: {} };`
        : `export default { experimental: { ${option}: false } };`;
    const context = project({ "next.config.ts": written });
    expect(predicate?.detectUsed(context, surface(id)).matched).toBe(true);
  });

  it("should have emptied the examination queue", () => {
    // The queue was written with eight groups and thirty-two options. All eight are examined.
    //
    // The three assertions above now pass over an empty list and therefore assert nothing: no
    // duplicate to find, no examined option to catch, no derived predicate to check. They are
    // kept because they guard the list, not its current contents — a tranche added tomorrow is
    // held to all three again. This assertion is what says the list is empty today, so that
    // "those three pass" is never mistaken for "those three checked something".
    expect(EXAMINATION_TRANCHES).toEqual([]);
  });
});

describe("the last tranche, at the edge of the server", () => {
  const EDGE = [
    ["proxyClientMaxBodySize", "reported as a constraint"],
    ["htmlLimitedBots", "by definition"],
    ["httpAgentOptions", "prior to 18"],
  ] as const;

  /**
   * Two of the three were reopened and carry their measurement on the predicate that replaced the
   * refusal; the third kept its refusal, so it carries it where it always did. Read off whichever
   * field holds it, because what the tranche promised is that the sentence survives — not which
   * side of a conversion it ends up on.
   */
  it.each(EDGE)("should keep the outcome that refused %s", (option, fragment) => {
    const predicate = CONFIG_PREDICATES.find(
      (entry) => entry.id === `config/next-config-js/${option}`,
    );
    const silence = predicate?.noSuggestion;
    const outcome =
      silence?.kind === "examined" ? silence.outcome : predicate?.reopenedFrom?.outcome;
    expect(outcome).toContain(fragment);
    expect(predicate?.wouldApply).toBeUndefined();
  });

  it.each(EDGE.map(([option]) => option))(
    "should report %s as used where it is configured",
    (option) => {
      const id = `config/next-config-js/${option}`;
      const predicate = CONFIG_PREDICATES.find((entry) => entry.id === id);
      const context = project({ "next.config.ts": `export default { ${option}: {} };` });
      expect(predicate?.detectUsed(context, surface(id)).matched).toBe(true);
    },
  );
});

describe("the pages whose name is not their key", () => {
  it("should not map appDir, which needs no key", () => {
    // Its page is `version: legacy`, and a legacy entry is filed as not applicable before any
    // predicate runs. It was recorded as a gap for sharing a shelf with four pages whose problem
    // it does not have.
    expect(MAPPED_PAGE_KEYS.appDir).toBeUndefined();
  });

  it("should leave a page whose name is its key untouched", () => {
    const context = project({ "next.config.ts": "export default { basePath: '/docs' };" });
    const entry = surface("config/next-config-js/basePath");
    expect(configOptionPredicate(entry)?.detectUsed(context, entry).matched).toBe(true);
  });

  it.each([
    ["incrementalCacheHandlerPath", "export default { cacheHandler: './h.js' };"],
    ["turbopackIgnoreIssue", "export default { turbopack: { ignoreIssue: [] } };"],
    ["staticGeneration", "export default { experimental: { staticGenerationRetryCount: 2 } };"],
    [
      "turbopackFileSystemCache",
      "export default { experimental: { turbopackFileSystemCacheForDev: true } };",
    ],
  ])("should report %s as used through the key it documents", (option, written) => {
    const context = project({ "next.config.ts": written });
    const entry = surface(`config/next-config-js/${option}`);
    expect(configOptionPredicate(entry)?.detectUsed(context, entry).matched).toBe(true);
  });

  it("should name which of a page's keys were found", () => {
    const context = project({
      "next.config.ts":
        "export default { experimental: { staticGenerationRetryCount: 2, staticGenerationMaxConcurrency: 4 } };",
    });
    const entry = surface("config/next-config-js/staticGeneration");
    const verdict = configOptionPredicate(entry)?.detectUsed(context, entry);
    expect(verdict?.note).toContain("RetryCount");
    expect(verdict?.note).toContain("MaxConcurrency");
    expect(verdict?.note).not.toContain("MinPagesPerWorker");
  });

  it("should not report a mapped page where none of its keys is configured", () => {
    const context = project({ "next.config.ts": "export default { experimental: {} };" });
    const entry = surface("config/next-config-js/staticGeneration");
    expect(configOptionPredicate(entry)?.detectUsed(context, entry).matched).toBe(false);
  });
});

/**
 * The flags that are on, converted to conditions. Each entry answered with a refusal before the
 * prohibition on reopening one was lifted, so each carries that refusal and ships behind `--strict`
 * — which is what these assert alongside the condition itself.
 */
describe("flags reopened under the strict preset", () => {
  const strictly = (id: string, files: Record<string, string>) => {
    const found = CONFIG_PREDICATES.find((predicate) => predicate.id === id);
    if (!found) throw new Error(`no predicate for ${id}`);
    const condition = found.wouldApplyStrict;
    if (!condition) throw new Error(`${id} carries no strict condition`);
    return { found, verdict: condition(project({ ...TS, ...files }), surface(id)) };
  };

  const ids = {
    taint: "config/next-config-js/taint",
    cacheComponents: "config/next-config-js/cacheComponents",
    partialPrefetching: "config/next-config-js/partialPrefetching",
    rustCompiler: "config/next-config-js/turbopackRustReactCompiler",
    typescript: "config/next-config-js/typescript",
  } as const;

  it("should carry the refusal it replaced on every one of them", () => {
    for (const id of Object.values(ids)) {
      const found = CONFIG_PREDICATES.find((predicate) => predicate.id === id);
      expect(found?.reopenedFrom?.condition, id).toBeTruthy();
      expect(found?.reopenedFrom?.outcome, id).toBeTruthy();
    }
  });

  it("should register every one of them as strict-only", () => {
    for (const id of Object.values(ids)) {
      const found = CONFIG_PREDICATES.find((predicate) => predicate.id === id);
      expect(found?.wouldApplyStrict, id).toBeDefined();
      expect(found?.wouldApply, id).toBeUndefined();
    }
  });

  describe("a flag on with the API it admits never called", () => {
    const TAINTING =
      "import { experimental_taintUniqueValue } from 'react';\n" +
      "export const f = (v: string) => experimental_taintUniqueValue('no', {}, v);\n";

    it("should report the flag set with neither taint function called", () => {
      const { verdict } = strictly(ids.taint, {
        "next.config.ts": "export default { experimental: { taint: true } };",
        "app/page.tsx": "export default () => null;",
      });
      expect(verdict.matched).toBe(true);
      expect(verdict.note).toContain("experimental channel");
    });

    it("should stay silent where a taint function is called", () => {
      const { verdict } = strictly(ids.taint, {
        "next.config.ts": "export default { experimental: { taint: true } };",
        "app/secret.ts": TAINTING,
      });
      expect(verdict.matched).toBe(false);
    });

    it("should stay silent where the flag is not on", () => {
      const { verdict } = strictly(ids.taint, {
        "next.config.ts": "export default {};",
        "app/page.tsx": "export default () => null;",
      });
      expect(verdict.matched).toBe(false);
    });

    it("should report Cache Components on with no cache directive anywhere", () => {
      const { verdict } = strictly(ids.cacheComponents, {
        "next.config.ts": "export default { cacheComponents: true };",
        "app/page.tsx": "export default () => null;",
      });
      expect(verdict.matched).toBe(true);
    });

    it("should stay silent where a file carries one", () => {
      const { verdict } = strictly(ids.cacheComponents, {
        "next.config.ts": "export default { cacheComponents: true };",
        "app/data.ts": "'use cache'\nexport const x = 1;\n",
      });
      expect(verdict.matched).toBe(false);
    });
  });

  describe("an option whose page names a prerequisite", () => {
    it("should report partialPrefetching set with cacheComponents unset", () => {
      const { verdict } = strictly(ids.partialPrefetching, {
        "next.config.ts": "export default { experimental: { partialPrefetching: true } };",
      });
      expect(verdict.matched).toBe(true);
      expect(verdict.note).toContain("config validation");
    });

    it("should stay silent where the prerequisite is set", () => {
      const { verdict } = strictly(ids.partialPrefetching, {
        "next.config.ts":
          "export default { cacheComponents: true, experimental: { partialPrefetching: true } };",
      });
      expect(verdict.matched).toBe(false);
    });

    it("should report the rust compiler set with reactCompiler unset", () => {
      const { verdict } = strictly(ids.rustCompiler, {
        "next.config.ts": "export default { experimental: { turbopackRustReactCompiler: true } };",
      });
      expect(verdict.matched).toBe(true);
      expect(verdict.note).toContain("reactCompiler");
    });

    it("should stay silent where reactCompiler is set", () => {
      const { verdict } = strictly(ids.rustCompiler, {
        "next.config.ts":
          "export default { reactCompiler: true, experimental: { turbopackRustReactCompiler: true } };",
      });
      expect(verdict.matched).toBe(false);
    });

    /**
     * The bundler half, and the false positive it started as. A project can run an `analyze`
     * script on webpack beside a Turbopack build, and the page's *throws with webpack* is about the
     * build that runs the option — which the bundler set cannot attribute to a script. So webpack
     * alone reports and webpack among others does not.
     */
    it("should report the option where every build script runs webpack", () => {
      const found = CONFIG_PREDICATES.find((predicate) => predicate.id === ids.rustCompiler);
      const condition = found?.wouldApplyStrict;
      if (!condition) throw new Error("no strict condition on the rust compiler entry");
      const context = project({
        ...TS,
        "next.config.ts": "export default { experimental: { turbopackRustReactCompiler: true } };",
      });
      const onWebpack = {
        ...context,
        project: { ...context.project, bundlers: resolved(new Set<Bundler>(["webpack"])) },
      };
      const verdict = condition(onWebpack, surface(ids.rustCompiler));
      expect(verdict.matched).toBe(true);
      expect(verdict.note).toContain("webpack");
    });

    it("should stay silent where webpack runs beside Turbopack", () => {
      const found = CONFIG_PREDICATES.find((predicate) => predicate.id === ids.rustCompiler);
      const condition = found?.wouldApplyStrict;
      if (!condition) throw new Error("no strict condition on the rust compiler entry");
      const context = project({
        ...TS,
        "next.config.ts":
          "export default { reactCompiler: true, experimental: { turbopackRustReactCompiler: true } };",
      });
      const both = {
        ...context,
        project: {
          ...context.project,
          bundlers: resolved(new Set<Bundler>(["webpack", "turbopack"])),
        },
      };
      expect(condition(both, surface(ids.rustCompiler)).matched).toBe(false);
    });
  });

  /**
   * The accepted metrics are read from the installed package. A project with none installed hands
   * the condition an unresolved list, and a condition that reported then would be calling every
   * configured metric unaccepted on the strength of not having looked.
   */
  it("should stay silent where the release's accepted metrics cannot be read", () => {
    const id = "config/next-config-js/webVitalsAttribution";
    const found = CONFIG_PREDICATES.find((predicate) => predicate.id === id);
    const condition = found?.wouldApplyStrict;
    if (!condition) throw new Error("no strict condition on the web vitals entry");
    const context = project({
      ...TS,
      "next.config.ts": "export default { experimental: { webVitalsAttribution: ['NOPE'] } };",
    });
    expect(context.project.installedNext).toBeUndefined();
    expect(condition(context, surface(id)).matched).toBe(false);
  });

  describe("a value whose consequence its page states", () => {
    it("should report the build skipping the type check", () => {
      const { verdict } = strictly(ids.typescript, {
        "next.config.ts": "export default { typescript: { ignoreBuildErrors: true } };",
      });
      expect(verdict.matched).toBe(true);
      expect(verdict.note).toContain("type check");
    });

    it("should stay silent on the value that leaves the check on", () => {
      const { verdict } = strictly(ids.typescript, {
        "next.config.ts": "export default { typescript: { ignoreBuildErrors: false } };",
      });
      expect(verdict.matched).toBe(false);
    });
  });
});

/**
 * The conditions written for the cache and network options. One block per condition, each
 * with a shape that reports, one that does not, and — where the condition rests on something read
 * from the installed release — the case where that read comes back unresolved and the condition
 * has to go quiet rather than fall back.
 */
describe("the cache, expiry and request-handling family, reopened", () => {
  const idOf = (option: string) => `config/next-config-js/${option}`;

  function strictVerdict(option: string, context: PredicateContext) {
    const found = CONFIG_PREDICATES.find((entry) => entry.id === idOf(option));
    if (found === undefined) throw new Error(`no predicate for ${option}`);
    return found.wouldApplyStrict?.(context, surface(idOf(option)));
  }

  /**
   * A project carrying enough of an installed `next` for the bot-expression reader to work, with
   * the expression spelled the way the release ships it. Written out rather than pointing at a
   * real install: the vendored fixtures have no `node_modules`, and a test that only passes on a
   * machine with one is a test that skips itself where it matters.
   */
  function withBotExpression(files: Record<string, string>): PredicateContext {
    return project({
      ...files,
      "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.3.0" }),
      "node_modules/next/dist/shared/lib/router/utils/html-bots.js": [
        "const HTML_LIMITED_BOT_UA_RE = /[\\w-]+-Google|Google-[\\w-]+|Chrome-Lighthouse|Slurp|" +
          "DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|" +
          "redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|" +
          "facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|" +
          "SkypeUriPreview|Yeti|googleweblight/i;",
        "exports.HTML_LIMITED_BOT_UA_RE = HTML_LIMITED_BOT_UA_RE;",
      ].join("\n"),
    });
  }

  /**
   * Both package conditions filter against a list the installed release ships, and both go quiet
   * when it cannot be read. So a project proving one has to vendor the lists as well as the
   * dependency — the alternative is a test that passes because the reader failed.
   *
   * The names are padded to clear the plausibility floor each reader applies. A short list reads
   * as a list that was not found, which is the reader doing its job and not a case.
   */
  const PADDING = Array.from({ length: 45 }, (_, index) => `paquete-por-defecto-${index}`);

  function installedListsFor(alreadyHandled: readonly string[]): Record<string, string> {
    const names = [...PADDING, ...alreadyHandled];
    return {
      "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.3.0" }),
      "node_modules/next/dist/lib/server-external-packages.jsonc": [
        "[",
        ...names.map((name) => `  "${name}",`),
        "]",
      ].join("\n"),
      "node_modules/next/dist/esm/server/config.js": [
        "const optimizePackageImports = new Set([",
        "    ...userProvidedOptimizePackageImports,",
        ...names.map((name) => `    '${name}',`),
        "])",
      ].join("\n"),
    };
  }

  /** A declared dependency installed with the manifest and entry the conditions read. */
  function withDependency(
    files: Record<string, string>,
    name: string,
    manifest: Record<string, unknown>,
    entry: string,
    options: { readonly alreadyHandled?: readonly string[]; readonly entryPath?: string } = {},
  ): PredicateContext {
    const entryPath = options.entryPath ?? "index.js";
    return project(
      {
        ...files,
        ...installedListsFor(options.alreadyHandled ?? []),
        [`node_modules/${name}/package.json`]: JSON.stringify({
          name,
          version: "1.0.0",
          main: `./${entryPath}`,
          ...manifest,
        }),
        [`node_modules/${name}/${entryPath}`]: entry,
      },
      resolved(new Set([name])),
    );
  }

  describe("cacheHandlers reads the scope a directive names", () => {
    const CONFIGURED = "export default { cacheComponents: true };";

    it("should report a remote scope with no handler configured", () => {
      const context = project({
        "next.config.ts": CONFIGURED,
        "app/informes/page.tsx": ["'use cache: remote';", "export default function P() {}"].join(
          "\n",
        ),
      });
      const verdict = strictVerdict("cacheHandlers", context);
      expect(verdict?.matched).toBe(true);
      expect(verdict?.note).toContain("remote");
      expect(verdict?.gain).toContain("in-memory LRU");
    });

    it("should report a named scope the framework has no slot of its own for", () => {
      const context = project({
        "next.config.ts": CONFIGURED,
        "app/sesiones/page.tsx": ["'use cache: sessions';", "export default function P() {}"].join(
          "\n",
        ),
      });
      expect(strictVerdict("cacheHandlers", context)?.note).toContain("sessions");
    });

    it("should say nothing about the plain and the private scopes", () => {
      const context = project({
        "next.config.ts": CONFIGURED,
        "app/a/page.tsx": ["'use cache';", "export default function P() {}"].join("\n"),
        "app/b/page.tsx": ["'use cache: private';", "export default function P() {}"].join("\n"),
      });
      expect(strictVerdict("cacheHandlers", context)?.matched).toBe(false);
    });

    it("should say nothing where the scope already has its handler", () => {
      const context = project({
        "next.config.ts":
          "export default { cacheComponents: true, cacheHandlers: { remote: './r.js' } };",
        "app/informes/page.tsx": ["'use cache: remote';", "export default function P() {}"].join(
          "\n",
        ),
      });
      expect(strictVerdict("cacheHandlers", context)?.matched).toBe(false);
    });

    it("should be inert where cacheComponents is off, whatever the source holds", () => {
      const context = project({
        "next.config.ts": "export default {};",
        "app/informes/page.tsx": ["'use cache: remote';", "export default function P() {}"].join(
          "\n",
        ),
      });
      expect(strictVerdict("cacheHandlers", context)?.matched).toBe(false);
    });

    it("should ignore a test file holding the shape", () => {
      const context = project({
        "next.config.ts": CONFIGURED,
        "app/informes/page.test.tsx": [
          "'use cache: remote';",
          "export default function P() {}",
        ].join("\n"),
      });
      expect(strictVerdict("cacheHandlers", context)?.matched).toBe(false);
    });
  });

  describe("htmlLimitedBots compares a robots file against the installed expression", () => {
    const ROBOTS = (agent: string) =>
      [
        "export default function robots() {",
        `  return { rules: [{ userAgent: '${agent}', allow: '/' }] };`,
        "}",
      ].join("\n");

    it("should report an agent the installed expression does not match", () => {
      const context = withBotExpression({
        "next.config.ts": "export default {};",
        "app/robots.ts": ROBOTS("MiRastreador"),
      });
      const verdict = strictVerdict("htmlLimitedBots", context);
      expect(verdict?.matched).toBe(true);
      expect(verdict?.note).toContain("MiRastreador");
      expect(verdict?.gain).toContain("streaming");
    });

    it("should say nothing about an agent the expression already covers", () => {
      const context = withBotExpression({
        "next.config.ts": "export default {};",
        "app/robots.ts": ROBOTS("Bingbot"),
      });
      expect(strictVerdict("htmlLimitedBots", context)?.matched).toBe(false);
    });

    it("should say nothing where the only agent named is the wildcard", () => {
      const context = withBotExpression({
        "next.config.ts": "export default {};",
        "app/robots.ts": ROBOTS("*"),
      });
      expect(strictVerdict("htmlLimitedBots", context)?.matched).toBe(false);
    });

    it("should go quiet where the installed expression cannot be read", () => {
      const context = project({
        "next.config.ts": "export default {};",
        "app/robots.ts": ROBOTS("MiRastreador"),
      });
      expect(strictVerdict("htmlLimitedBots", context)?.matched).toBe(false);
    });

    it("should say nothing where the project sets the option", () => {
      const context = withBotExpression({
        "next.config.ts": "export default { htmlLimitedBots: /MiRastreador/ };",
        "app/robots.ts": ROBOTS("MiRastreador"),
      });
      expect(strictVerdict("htmlLimitedBots", context)?.matched).toBe(false);
    });
  });

  describe("reactMaxHeadersLength counts the calls that emit the header", () => {
    const PRELOADS = [
      "import { preload } from 'react-dom';",
      "export default function P() { preload('/a.woff2', { as: 'font' }); return null; }",
    ].join("\n");

    it("should report a module calling a resource-preloading API", () => {
      const context = project({
        "next.config.ts": "export default {};",
        "app/fuentes/page.tsx": PRELOADS,
      });
      const verdict = strictVerdict("reactMaxHeadersLength", context);
      expect(verdict?.matched).toBe(true);
      expect(verdict?.note).toContain("preload");
      expect(verdict?.gain).toContain("capped");
    });

    it("should say nothing about a preload the project wrote itself", () => {
      const context = project({
        "next.config.ts": "export default {};",
        "app/fuentes/page.tsx": [
          "import { preload } from '../../lib/mio.js';",
          "export default function P() { preload('/a.woff2'); return null; }",
        ].join("\n"),
        "lib/mio.ts": "export function preload(_: string) {}",
      });
      expect(strictVerdict("reactMaxHeadersLength", context)?.matched).toBe(false);
    });

    it("should ignore a test file holding the shape", () => {
      const context = project({
        "next.config.ts": "export default {};",
        "app/fuentes/page.test.tsx": PRELOADS,
      });
      expect(strictVerdict("reactMaxHeadersLength", context)?.matched).toBe(false);
    });

    it("should say nothing where the project sets the option", () => {
      const context = project({
        "next.config.ts": "export default { reactMaxHeadersLength: 1000 };",
        "app/fuentes/page.tsx": PRELOADS,
      });
      expect(strictVerdict("reactMaxHeadersLength", context)?.matched).toBe(false);
    });
  });

  describe("proxyClientMaxBodySize reads the body reader the page publishes", () => {
    const PROXY = [
      "export default async function proxy(request: Request) {",
      "  const body = await request.text();",
      "  return new Response(body);",
      "}",
    ].join("\n");

    it("should report a proxy that reads the request body", () => {
      const context = project({ "next.config.ts": "export default {};", "proxy.ts": PROXY });
      const verdict = strictVerdict("proxyClientMaxBodySize", context);
      expect(verdict?.matched).toBe(true);
      expect(verdict?.note).toContain("request.text()");
      expect(verdict?.gain).toContain("truncated");
    });

    /**
     * The reading located the proxy from four literal names, so this predicate saw no proxy at all
     * in a project whose proxy was a `.tsx` file — the same blindness the convention entry had.
     */
    it("should read a proxy under an extension outside the four names it was written from", () => {
      const context = project({ "next.config.ts": "export default {};", "proxy.tsx": PROXY });
      expect(strictVerdict("proxyClientMaxBodySize", context)?.matched).toBe(true);
    });

    it("should say nothing about a proxy that reads nothing off the request", () => {
      const context = project({
        "next.config.ts": "export default {};",
        "proxy.ts": "export default function proxy() { return undefined; }",
      });
      expect(strictVerdict("proxyClientMaxBodySize", context)?.matched).toBe(false);
    });

    it("should not read a response the proxy builds as a body it consumed", () => {
      const context = project({
        "next.config.ts": "export default {};",
        "proxy.ts": [
          "import { NextResponse } from 'next/server';",
          "export default function proxy() { return NextResponse.json({ ok: true }); }",
        ].join("\n"),
      });
      expect(strictVerdict("proxyClientMaxBodySize", context)?.matched).toBe(false);
    });

    it("should say nothing about a route handler reading a body with no proxy present", () => {
      const context = project({
        "next.config.ts": "export default {};",
        "app/api/subir/route.ts": [
          "export async function POST(request: Request) {",
          "  const body = await request.text();",
          "  return new Response(body);",
          "}",
        ].join("\n"),
      });
      expect(strictVerdict("proxyClientMaxBodySize", context)?.matched).toBe(false);
    });

    it("should say nothing where the project sets the option", () => {
      const context = project({
        "next.config.ts": "export default { experimental: { proxyClientMaxBodySize: '1mb' } };",
        "proxy.ts": PROXY,
      });
      expect(strictVerdict("proxyClientMaxBodySize", context)?.matched).toBe(false);
    });
  });

  describe("the two package conditions read the installed dependency", () => {
    const SERVER_PAGE = [
      "import { compile } from 'motor-nativo';",
      "export default function P() { return compile(); }",
    ].join("\n");

    it("should report a native dependency reached from the server", () => {
      const context = withDependency(
        { "next.config.ts": "export default {};", "app/informes/page.tsx": SERVER_PAGE },
        "motor-nativo",
        { gypfile: true },
        "module.exports = {};",
      );
      const verdict = strictVerdict("serverExternalPackages", context);
      expect(verdict?.matched).toBe(true);
      expect(verdict?.note).toContain("motor-nativo");
      expect(verdict?.gain).toContain("require");
    });

    it("should say nothing about a dependency declaring no native addon", () => {
      const context = withDependency(
        { "next.config.ts": "export default {};", "app/informes/page.tsx": SERVER_PAGE },
        "motor-nativo",
        {},
        "module.exports = {};",
      );
      expect(strictVerdict("serverExternalPackages", context)?.matched).toBe(false);
    });

    it.each([
      ["serverExternalPackages", { gypfile: true }, "module.exports = {};"],
      ["optimizePackageImports", {}, "export * from './uno.js';"],
    ] as const)(
      "should say nothing to %s about a package the installed default list already names",
      (option, manifest, entry) => {
        const context = withDependency(
          {
            "next.config.ts": "export default {};",
            "app/informes/page.tsx": [
              "import { uno } from 'ya-tratado';",
              "export default function P() { return uno(); }",
            ].join("\n"),
          },
          "ya-tratado",
          manifest,
          entry,
          { alreadyHandled: ["ya-tratado"] },
        );
        expect(strictVerdict(option, context)?.matched).toBe(false);
      },
    );

    it("should say nothing about a native dependency the configuration already names", () => {
      const context = withDependency(
        {
          "next.config.ts": "export default { serverExternalPackages: ['motor-nativo'] };",
          "app/informes/page.tsx": SERVER_PAGE,
        },
        "motor-nativo",
        { gypfile: true },
        "module.exports = {};",
      );
      expect(strictVerdict("serverExternalPackages", context)?.matched).toBe(false);
    });

    it("should report a barrel dependency imported by name", () => {
      const context = withDependency(
        {
          "next.config.ts": "export default {};",
          "app/informes/page.tsx": [
            "import { uno } from 'barril';",
            "export default function P() { return uno(); }",
          ].join("\n"),
        },
        "barril",
        {},
        ["export * from './uno.js';", "export * from './dos.js';"].join("\n"),
      );
      const verdict = strictVerdict("optimizePackageImports", context);
      expect(verdict?.matched).toBe(true);
      expect(verdict?.note).toContain("barril");
      expect(verdict?.gain).toContain("named import");
    });

    it("should say nothing about a barrel imported only as a default", () => {
      const context = withDependency(
        {
          "next.config.ts": "export default {};",
          "app/informes/page.tsx": [
            "import barril from 'barril';",
            "export default function P() { return barril(); }",
          ].join("\n"),
        },
        "barril",
        {},
        ["export * from './uno.js';", "export * from './dos.js';"].join("\n"),
      );
      expect(strictVerdict("optimizePackageImports", context)?.matched).toBe(false);
    });

    it("should say nothing about an entry module that is not a barrel", () => {
      const context = withDependency(
        {
          "next.config.ts": "export default {};",
          "app/informes/page.tsx": [
            "import { uno } from 'barril';",
            "export default function P() { return uno(); }",
          ].join("\n"),
        },
        "barril",
        {},
        "export function uno() { return 1; }",
      );
      expect(strictVerdict("optimizePackageImports", context)?.matched).toBe(false);
    });

    it("should go quiet where the dependency is declared and not installed", () => {
      const context = project(
        {
          "next.config.ts": "export default {};",
          "app/informes/page.tsx": SERVER_PAGE,
          ...installedListsFor([]),
        },
        resolved(new Set(["motor-nativo"])),
      );
      expect(strictVerdict("serverExternalPackages", context)?.matched).toBe(false);
      expect(strictVerdict("optimizePackageImports", context)?.matched).toBe(false);
    });

    /**
     * A bare specifier is not a package name on its own. A project mapping `baseUrl` onto its own
     * source writes `import { uno } from 'barril'` and means `src/barril.ts`; a dependency of that
     * name in the manifest makes the pair look like an import of the package, and the finding
     * would cite a file that never touched it.
     */
    it("should not read an internally resolved bare specifier as a package", () => {
      const context = withDependency(
        {
          "next.config.ts": "export default {};",
          "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
          "src/barril.ts": "export function uno() { return 1; }",
          "app/informes/page.tsx": [
            "import { uno } from 'barril';",
            "export default function P() { return uno(); }",
          ].join("\n"),
        },
        "barril",
        {},
        ["export * from './uno.js';", "export * from './dos.js';"].join("\n"),
      );
      expect(strictVerdict("optimizePackageImports", context)?.matched).toBe(false);
    });

    /**
     * A list with an element nobody could read was read in part. Treating it as the whole list
     * would report a package the project configured through the half that did not resolve.
     */
    it.each(["serverExternalPackages", "optimizePackageImports"] as const)(
      "should go quiet for %s where the configured list was only read in part",
      (option) => {
        const context = withDependency(
          {
            "next.config.ts": [
              "const PESADOS = ['barril'];",
              `export default { ${option}: [...PESADOS, 'otro'] };`,
            ].join("\n"),
            "app/informes/page.tsx": [
              "import { uno } from 'barril';",
              "export default function P() { return uno(); }",
            ].join("\n"),
          },
          "barril",
          { gypfile: true },
          ["export * from './uno.js';", "export * from './dos.js';"].join("\n"),
        );
        expect(strictVerdict(option, context)?.matched).toBe(false);
      },
    );

    /**
     * The reading that made this condition name `@playwright/test` on every project it was first
     * measured against. A config file at the project root is production by the scan's reckoning —
     * it is not a test by name — and it is not in a bundle, so what it imports is not what a named
     * import costs one.
     */
    it("should not read a config file at the root as code the bundler holds", () => {
      const context = withDependency(
        {
          "next.config.ts": "export default {};",
          "playwright.config.ts": [
            "import { defineConfig } from 'barril';",
            "export default defineConfig({});",
          ].join("\n"),
        },
        "barril",
        {},
        ["export * from './uno.js';", "export * from './dos.js';"].join("\n"),
      );
      expect(strictVerdict("optimizePackageImports", context)?.matched).toBe(false);
    });
  });

  describe("incrementalCacheHandlerPath reads the handler the project did configure", () => {
    const derivedVerdict = (files: Record<string, string>) => {
      const id = idOf("incrementalCacheHandlerPath");
      const entry = surface(id);
      const predicates = configOptionPredicate(entry);
      return {
        used: predicates?.detectUsed(project(files), entry),
        suggested: predicates?.wouldApplyStrict?.(project(files), entry),
      };
    };

    it("should report the plural configured with the singular unset", () => {
      const { suggested } = derivedVerdict({
        "next.config.ts": "export default { cacheHandlers: { default: './d.js' } };",
      });
      expect(suggested?.matched).toBe(true);
      expect(suggested?.note).toContain("cacheHandler");
      expect(suggested?.gain).toContain("optimised images");
    });

    it("should say nothing where the singular is configured", () => {
      const { used, suggested } = derivedVerdict({
        "next.config.ts":
          "export default { cacheHandler: './c.js', cacheHandlers: { default: './d.js' } };",
      });
      expect(used?.matched).toBe(true);
      expect(suggested?.matched).toBe(false);
    });

    it("should say nothing where neither spelling is configured", () => {
      const { suggested } = derivedVerdict({ "next.config.ts": "export default {};" });
      expect(suggested?.matched).toBe(false);
    });

    it("should keep reporting the page as used through the key its mapping names", () => {
      const { used } = derivedVerdict({
        "next.config.ts": "export default { cacheHandler: './c.js' };",
      });
      expect(used?.matched).toBe(true);
      expect(used?.note).toContain("cacheHandler");
    });

    it("should carry no reopened objection, having replaced no refusal", () => {
      const predicates = configOptionPredicate(surface(idOf("incrementalCacheHandlerPath")));
      expect(predicates?.reopenedFrom).toBeUndefined();
      expect(predicates?.noSuggestion).toBeUndefined();
    });
  });

  describe("staticGeneration is examined and produces no condition", () => {
    it("should record the condition tried and the outcome that refused it", () => {
      const predicates = configOptionPredicate(surface(idOf("staticGeneration")));
      const silence = predicates?.noSuggestion;
      expect(silence?.kind).toBe("examined");
      if (silence?.kind !== "examined") return;
      expect(silence.condition).toContain("worker");
      expect(silence.outcome).toContain("properties of the run");
      expect(predicates?.wouldApplyStrict).toBeUndefined();
    });

    it("should read as examined rather than as the group's sentence", () => {
      const predicates = configOptionPredicate(surface(idOf("staticGeneration")));
      expect(
        reasonFor(
          predicates?.noSuggestion ?? { kind: "abstained", why: "", measuredAgainst: "16.3.0" },
        ),
      ).not.toContain(DERIVED_OPTION_REASON);
    });

    it("should stay one entry over the three keys its page documents", () => {
      const entry = surface(idOf("staticGeneration"));
      const predicates = configOptionPredicate(entry);
      const context = project({
        "next.config.ts": "export default { experimental: { staticGenerationMaxConcurrency: 8 } };",
      });
      const used = predicates?.detectUsed(context, entry);
      expect(used?.matched).toBe(true);
      expect(used?.note).toContain("experimental.staticGenerationMaxConcurrency");
    });
  });

  describe("the two entries this family left refused", () => {
    it.each([
      ["expireTime", "ternary on an environment variable"],
      ["prefetchInlining", "arrived in the same release"],
    ])("should record what closed %s rather than a condition", (option, fragment) => {
      const found = CONFIG_PREDICATES.find((entry) => entry.id === idOf(option));
      const silence = found?.noSuggestion;
      expect(silence?.kind).toBe("examined");
      if (silence?.kind !== "examined") return;
      expect(silence.outcome).toContain(fragment);
      expect(found?.wouldApply).toBeUndefined();
      expect(found?.wouldApplyStrict).toBeUndefined();
    });
  });
});

describe("a package the release lists under a subpath", () => {
  /**
   * The defect, at the comparison that made it. A release lists what it handles the way it handles
   * it, and 16.3.0 names `react-icons/si` and `react-icons/fc` individually while never naming
   * `react-icons`. Reducing an import to its package name before asking missed both, and
   * `ItusiAI/MokerSaaS` — which imports exactly those two — was told to add `react-icons` to
   * `optimizePackageImports`, an entry that would have optimised nothing.
   */
  it("should read a subpath the list names as already handled", () => {
    const handled = new Set(["react-icons/si", "react-icons/fc"]);
    expect(alreadyHandles(handled, "react-icons/si", "react-icons")).toBe(true);
    expect(alreadyHandles(handled, "react-icons/fc", "react-icons")).toBe(true);
  });

  /** Not silence: a subpath the release does not list is a real gap and stays reportable. */
  it("should leave a subpath the list does not name unhandled", () => {
    const handled = new Set(["react-icons/si", "react-icons/fc"]);
    expect(alreadyHandles(handled, "react-icons/pi", "react-icons")).toBe(false);
  });

  /** The bare reading is kept: the server-external list is bare today and must keep matching. */
  it("should still read a bare name the list names as already handled", () => {
    expect(alreadyHandles(new Set(["lucide-react"]), "lucide-react", "lucide-react")).toBe(true);
    expect(alreadyHandles(new Set(["lucide-react"]), "lucide-react/icons", "lucide-react")).toBe(
      true,
    );
  });
});
