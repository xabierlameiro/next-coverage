import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolved } from "../types.js";
import {
  readFlag,
  readFlagList,
  readFlagPresence,
  readNextConfig,
  readPageExtensions,
} from "./config.js";

/** Writes a next.config.ts holding the given source and reads it back. */
function configOf(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "next-coverage-config-"));
  writeFileSync(join(dir, "next.config.ts"), source);
  return readNextConfig(dir);
}

const BODY = "const nextConfig = { typedRoutes: true, experimental: { taint: true } };";

describe("plugin wrappers", () => {
  it("should read a config wrapped by a single plugin", () => {
    const config = configOf(`${BODY}\nexport default withMDX(nextConfig);\n`);
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should read a config wrapped by plugins in sequence", () => {
    const config = configOf(`${BODY}\nexport default withA(withB(withC(nextConfig)));\n`);
    expect(readFlag(config, "experimental.taint")).toEqual({ status: "resolved", value: true });
  });

  it("should read a curried plugin without mistaking its options for the config", () => {
    // The shape the contrast fixture ships: the plugin is configured, then applied.
    const config = configOf(
      `${BODY}\nexport default withAnalyzer({ enabled: true })(withIntl(nextConfig));\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
    // `enabled` belongs to the plugin, not to Next.js. Reading it would mean the wrong object
    // was taken as the config.
    expect(readFlag(config, "enabled")).toEqual({ status: "resolved" });
  });

  it("should refuse a config wrapped deeper than the bound", () => {
    const deep = `w1(w2(w3(w4(w5(w6(w7(nextConfig)))))))`;
    const config = configOf(`${BODY}\nexport default ${deep};\n`);
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("deep");
  });

  it("should still read a bare object literal export", () => {
    const config = configOf("export default { typedRoutes: true };\n");
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should read the config a plugin fold seeds rather than the reducer applying it", () => {
    // `jakejarvis/jarv.is` applies its plugins this way. The reducer is the first argument and
    // the config the second, so following the first argument read no config at all.
    const config = configOf(
      `${BODY}\nexport default (): NextConfig =>\n  nextPlugins.reduce((acc, plugin) => plugin(acc), nextConfig);\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
    expect(readFlag(config, "experimental.taint")).toEqual({ status: "resolved", value: true });
  });

  it("should refuse a call whose arguments are all functions", () => {
    const config = configOf(
      `${BODY}\nexport default compose((a) => a, function (b) { return b; });\n`,
    );
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("all functions");
  });

  it("should read a config a conditional applies a plugin to on one branch only", () => {
    // `dkast/biztro` names the conditional and exports the name. Both branches are the same
    // config, one of them wrapped, so which branch runs does not change what is configured.
    const config = configOf(
      `${BODY}\nconst wrapped = analyse ? withBundleAnalyzer(nextConfig) : nextConfig;\nexport default wrapped;\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
    expect(readFlag(config, "experimental.taint")).toEqual({ status: "resolved", value: true });
  });

  it("should read a conditional written straight into the default export", () => {
    const config = configOf(
      `${BODY}\nexport default process.env.ANALYSE ? withBundleAnalyzer(nextConfig) : nextConfig;\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should refuse a conditional whose branches are different configs", () => {
    const config = configOf(
      `${BODY}\nconst other = { typedRoutes: false };\nexport default analyse ? nextConfig : other;\n`,
    );
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("branch");
  });

  it("should read a conditional nested inside the branch of another", () => {
    const config = configOf(
      `${BODY}\nexport default a ? (b ? withMDX(nextConfig) : nextConfig) : nextConfig;\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should refuse conditionals nested deeper than the bound", () => {
    const depth = 8;
    const nested = `${"deeper ? nextConfig : (".repeat(depth)}nextConfig${")".repeat(depth)}`;
    const config = configOf(`${BODY}\nexport default ${nested};\n`);
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("deep");
  });

  it("should answer rather than throw on names that cycle through conditionals", () => {
    // Three lines, and the parser reads them without trouble. Each branch is walked by a fresh
    // call, which restarts the count guarding the name-following loop, so before conditionals
    // were counted across those calls this descended until the stack ran out.
    const config = configOf(
      "const a = flag ? b : b;\nconst b = flag ? a : a;\nexport default a;\n",
    );
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("deep");
  });

  it("should refuse branches holding literals written apart, however alike they read", () => {
    // Node identity, deliberately: two literals written apart are two configurations, and
    // comparing them structurally would be a claim about sameness this reader does not make.
    const config = configOf(
      "export default analyse ? { typedRoutes: true } : { typedRoutes: true };\n",
    );
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("branch");
  });

  it("should read a conditional a plugin is applied around", () => {
    const config = configOf(
      `${BODY}\nexport default withMDX(analyse ? nextConfig : nextConfig);\n`,
    );
    expect(readFlag(config, "experimental.taint")).toEqual({ status: "resolved", value: true });
  });
});

describe("a config exported as a function", () => {
  it("should read a function declaration exported as default", () => {
    const config = configOf(`${BODY}\nexport default function config() { return nextConfig; }\n`);
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should read an async function, the form the documentation shows", () => {
    const config = configOf(
      `${BODY}\nexport default async function config() { return nextConfig; }\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should read an arrow function assigned as the default export", () => {
    const config = configOf(`${BODY}\nexport default () => nextConfig;\n`);
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should read a function expression exported as default", () => {
    const config = configOf(`${BODY}\nexport default function () { return nextConfig; };\n`);
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should follow a name to the function it holds", () => {
    // `polarsource/polar` writes `const createConfig = async () => { … return conf }` and exports
    // the name. Stopping at the name rather than reading its returns cost eight of the thirteen
    // constraints — the lowest figure measured against a real project.
    const named = configOf(
      `${BODY}\nconst createConfig = () => nextConfig;\nexport default createConfig;\n`,
    );
    expect(readFlag(named, "typedRoutes")).toEqual({ status: "resolved", value: true });

    const asyncBody = configOf(
      `${BODY}\nconst createConfig = async () => {\n  const conf = withMDX(nextConfig);\n  return conf;\n}\nexport default createConfig;\n`,
    );
    expect(readFlag(asyncBody, "typedRoutes")).toEqual({ status: "resolved", value: true });

    const declaration = configOf(
      `${BODY}\nfunction createConfig() { return nextConfig; }\nexport default createConfig;\n`,
    );
    expect(readFlag(declaration, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should terminate on names that reach each other through functions", () => {
    // The walk that counts functions across the recursion rather than restarting it. Two names
    // returning each other descend forever otherwise, which is how the conditional walk once
    // overflowed the stack.
    const config = configOf("const a = () => b();\nconst b = () => a();\nexport default a;\n");
    expect(readFlag(config, "typedRoutes").status).toBe("unresolved");
  });

  it("should keep its refusals when the function is behind a name", () => {
    const twice = configOf(
      `${BODY}\nconst make = () => nextConfig;\nconst make = () => ({ typedRoutes: false });\nexport default make;\n`,
    );
    expect(readFlag(twice, "typedRoutes").status).toBe("unresolved");

    const perBranch = configOf(
      `${BODY}\nconst other = { typedRoutes: false };\nconst make = (phase) => {\n  if (phase === 'x') return other;\n  return nextConfig;\n}\nexport default make;\n`,
    );
    expect(readFlag(perBranch, "typedRoutes").status).toBe("unresolved");

    const reassigned = configOf(
      `${BODY}\nlet make = () => nextConfig;\nmake = () => ({ typedRoutes: false });\nexport default make;\n`,
    );
    expect(readFlag(reassigned, "typedRoutes").status).toBe("unresolved");
  });

  it("should read a function returning the object literal directly", () => {
    const config = configOf("export default function config() { return { typedRoutes: true }; }\n");
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should read two returns that reach the same config", () => {
    // The measured shape: a branch adds a wrapper and both return the same object underneath.
    const config = configOf(
      `${BODY}\nexport default function config(phase) {\n  if (phase === 'x') return withAnalyzer(nextConfig);\n  return nextConfig;\n}\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should refuse a function returning a different config per branch", () => {
    const config = configOf(
      `${BODY}\nconst other = { typedRoutes: false };\nexport default function config(phase) {\n  if (phase === 'x') return other;\n  return nextConfig;\n}\n`,
    );
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("per branch");
  });

  it("should not read a return belonging to a callback inside the function", () => {
    // The callback returns to whoever calls it, not to the framework.
    const config = configOf(
      `${BODY}\nexport default function config() {\n  const build = () => ({ typedRoutes: false });\n  return nextConfig;\n}\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should refuse a function that returns nothing", () => {
    const config = configOf(`${BODY}\nexport default function config() { const a = 1; }\n`);
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("returns nothing");
  });
});

describe("following a name to the config", () => {
  it("should follow more than one hop", () => {
    const config = configOf(
      `${BODY}\nconst wrapped = withMDX(nextConfig);\nexport default wrapped;\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should resolve a name declared inside the function before one outside it", () => {
    // The measured shape in full: a name in the body, bound to a wrapper call, over a module
    // object.
    const config = configOf(
      `${BODY}\nexport default function config() {\n  const mdxConfig = withMDX(nextConfig);\n  return mdxConfig;\n}\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should refuse a name the file declares twice", () => {
    const config = configOf(
      `${BODY}\nconst a = nextConfig;\nconst a = { typedRoutes: false };\nexport default a;\n`,
    );
    expect(readFlag(config, "typedRoutes").status).toBe("unresolved");
  });

  it("should refuse a name assigned after it is declared", () => {
    const config = configOf(
      `let a = nextConfig;\n${BODY}\na = { typedRoutes: false };\nexport default a;\n`,
    );
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("assigned");
  });

  it("should refuse a chain of names deeper than the bound", () => {
    const chain = [
      "a1 = nextConfig",
      "a2 = a1",
      "a3 = a2",
      "a4 = a3",
      "a5 = a4",
      "a6 = a5",
      "a7 = a6",
    ]
      .map((one) => `const ${one};`)
      .join("\n");
    const config = configOf(`${BODY}\n${chain}\nexport default a7;\n`);
    const flag = readFlag(config, "typedRoutes");
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("deep");
  });

  it("should follow a name every assignment only wraps", () => {
    // `polarsource/polar` chains its plugins by reassignment inside the config function, which is
    // the ordinary shape once there are more than two. Applying a plugin to a configuration does
    // not replace it, so the declaration is still what the framework ends up with.
    const inBody = configOf(
      `${BODY}\nconst make = () => {\n  let conf = withMDX(nextConfig);\n  conf = withSentry(conf, { org: 'x' });\n  return conf;\n}\nexport default make;\n`,
    );
    expect(readFlag(inBody, "typedRoutes")).toEqual({ status: "resolved", value: true });

    const atTopLevel = configOf(
      `${BODY}\nlet conf = nextConfig;\nconf = withMDX(conf);\nexport default conf;\n`,
    );
    expect(readFlag(atTopLevel, "typedRoutes")).toEqual({ status: "resolved", value: true });
  });

  it("should refuse a name wrapped in one place and replaced in another", () => {
    // One replacement is enough: the declaration is stale however plainly another assignment wraps.
    const config = configOf(
      `${BODY}\nlet conf = nextConfig;\nconf = withMDX(conf);\nconf = makeOther();\nexport default conf;\n`,
    );
    expect(readFlag(config, "typedRoutes").status).toBe("unresolved");
  });

  it("should refuse a call that carries something other than the name", () => {
    const config = configOf(
      `${BODY}\nconst other = { typedRoutes: false };\nlet conf = nextConfig;\nconf = withMDX(other);\nexport default conf;\n`,
    );
    expect(readFlag(config, "typedRoutes").status).toBe("unresolved");
  });

  it("should refuse a name an assignment overrides through", () => {
    // The one case that would report a WRONG value rather than report less: the assignment spreads
    // the name and writes a key the declaration already set. Reading past it would answer `true`
    // for a project that turned the option off two lines later.
    const config = configOf(
      "const base = { cacheComponents: true };\nlet a = base;\na = { ...a, cacheComponents: false };\nexport default a;\n",
    );
    const flag = readFlag(config, "cacheComponents");
    expect(flag).not.toEqual({ status: "resolved", value: true });
    expect(flag.status).toBe("unresolved");
    if (flag.status === "unresolved") expect(flag.reason).toContain("assigned");
  });

  it("should refuse a name an assignment replaces outright", () => {
    const config = configOf(`${BODY}\nlet a = nextConfig;\na = makeOther();\nexport default a;\n`);
    const flag = readFlag(config, "typedRoutes");
    expect(flag).not.toEqual({ status: "resolved", value: true });
    expect(flag.status).toBe("unresolved");
  });

  it("should refuse a name that resolves to itself", () => {
    const config = configOf("const a = a;\nexport default a;\n");
    expect(readFlag(config, "typedRoutes").status).toBe("unresolved");
  });
});

describe("option presence", () => {
  it("should report an array or object value as present, though unreadable", () => {
    const config = configOf(
      "export default { serverExternalPackages: ['pg'], images: { formats: [] } };\n",
    );
    expect(readFlagPresence(config, "serverExternalPackages")).toEqual({
      status: "resolved",
      value: true,
    });
    expect(readFlag(config, "serverExternalPackages").status).toBe("unresolved");
    expect(readFlagPresence(config, "images")).toEqual({ status: "resolved", value: true });
  });

  it("should report an option nobody wrote as absent", () => {
    const config = configOf("export default { typedRoutes: true };\n");
    expect(readFlagPresence(config, "serverExternalPackages")).toEqual({
      status: "resolved",
      value: false,
    });
  });

  it("should never report absent when the walk could not be completed", () => {
    // An unreadable config, a spread, and a non-object in the middle of the path. None of the
    // three means the option is missing, and reporting it missing is how a tool suggests
    // adopting what a project already has.
    const unreadable = configOf("export default makeConfig();\n");
    expect(readFlagPresence(unreadable, "typedRoutes").status).toBe("unresolved");

    const spread = configOf("export default { ...base, typedRoutes: true };\n");
    expect(readFlagPresence(spread, "serverExternalPackages").status).toBe("unresolved");

    const shallow = configOf("export default { experimental: true };\n");
    expect(readFlagPresence(shallow, "experimental.taint").status).toBe("unresolved");
  });

  it("should still report absent past a spread whose keys are known", () => {
    // `saleor/storefront` and `hugodemenez/deltalytix` both spread a conditional between two
    // object literals. It can carry `allowedDevOrigins` and nothing else, so every other option
    // the file does not write is still absent — four of the twelve constraints fell on this.
    const config = configOf(
      "export default { ...(hosts?.length ? { allowedDevOrigins: hosts } : {}), typedRoutes: true };\n",
    );
    expect(readFlagPresence(config, "basePath")).toEqual({ status: "resolved", value: false });
    expect(readFlagPresence(config, "redirects")).toEqual({ status: "resolved", value: false });
  });

  it("should stay unresolved for an option a known spread could carry", () => {
    // Knowing the keys says what the spread may bring, not which branch a deploy takes.
    const config = configOf(
      "export default { ...(flag ? { basePath: '/app' } : {}), typedRoutes: true };\n",
    );
    expect(readFlagPresence(config, "basePath").status).toBe("unresolved");
  });

  it("should stay unresolved for a spread whose keys are not knowable", () => {
    const named = configOf("export default { ...base, typedRoutes: true };\n");
    expect(readFlagPresence(named, "basePath").status).toBe("unresolved");

    const called = configOf("export default { ...makeBase(), typedRoutes: true };\n");
    expect(readFlagPresence(called, "basePath").status).toBe("unresolved");

    // A computed key is a name this reader does not have, so the set is not the whole of it.
    const computed = configOf("export default { ...{ [key]: 1 }, typedRoutes: true };\n");
    expect(readFlagPresence(computed, "basePath").status).toBe("unresolved");

    // One side literal is not both sides literal.
    const half = configOf("export default { ...(flag ? base : { output: 'standalone' }) };\n");
    expect(readFlagPresence(half, "basePath").status).toBe("unresolved");
  });

  it("should read the keys of a spread nested inside a known one", () => {
    const config = configOf(
      "export default { ...(flag ? { ...{ output: 'standalone' } } : {}), typedRoutes: true };\n",
    );
    expect(readFlagPresence(config, "basePath")).toEqual({ status: "resolved", value: false });
    expect(readFlagPresence(config, "output").status).toBe("unresolved");
  });

  it("should read the keys of a name the file binds to an object literal", () => {
    // `47ng/nuqs` turns an option on by environment through a name it binds beside the config.
    // The literal is two lines above the spread, and reading nothing of it cost six of the
    // thirteen constraints.
    const config = configOf(
      "const extra = { cacheComponents: true };\nexport default { ...extra, typedRoutes: true };\n",
    );
    expect(readFlagPresence(config, "basePath")).toEqual({ status: "resolved", value: false });
    expect(readFlagPresence(config, "cacheComponents").status).toBe("unresolved");
  });

  it("should keep counting the spread it cannot read beside the one it can", () => {
    // The mixed case, written before the reader widened. Learning one spread's keys must not
    // settle what another spread could still be carrying: widening this reader has twice ended
    // with something unread quietly dropped from the count.
    const config = configOf(
      "const extra = { cacheComponents: true };\nexport default { ...extra, ...makeBase(), typedRoutes: true };\n",
    );
    expect(readFlagPresence(config, "basePath").status).toBe("unresolved");
    expect(readFlagPresence(config, "cacheComponents").status).toBe("unresolved");
  });

  it("should not read the keys of a name the file reassigns", () => {
    // What the name was declared with is not what it holds where it is spread, so the keys are
    // not knowable. Reporting an option absent from the stale binding would hide an option the
    // project configures.
    const reassigned = configOf(
      "let extra = { cacheComponents: true };\nextra = makeExtra();\nexport default { ...extra, typedRoutes: true };\n",
    );
    expect(readFlagPresence(reassigned, "basePath").status).toBe("unresolved");

    const twice = configOf(
      "const extra = { cacheComponents: true };\nconst extra = { basePath: '/x' };\nexport default { ...extra, typedRoutes: true };\n",
    );
    expect(readFlagPresence(twice, "basePath").status).toBe("unresolved");

    const notALiteral = configOf(
      "const extra = makeExtra();\nexport default { ...extra, typedRoutes: true };\n",
    );
    expect(readFlagPresence(notALiteral, "basePath").status).toBe("unresolved");
  });

  it("should read the keys a name holds through a conditional", () => {
    // The shape `47ng/nuqs` actually writes: the name is bound to a conditional between two
    // literals, not to a literal. Whether a value's keys are knowable is one question, asked in
    // one place, and the name is followed to the value rather than to a shape chosen in advance.
    const config = configOf(
      "const extra = process.env.X === 'true' ? { cacheComponents: true } : {};\nexport default { ...extra, typedRoutes: true };\n",
    );
    expect(readFlagPresence(config, "basePath")).toEqual({ status: "resolved", value: false });
    expect(readFlagPresence(config, "cacheComponents").status).toBe("unresolved");
  });

  it("should read the keys of a spread written as a logical and", () => {
    // `simstudioai/sim` adds a group of options in development this way. A false condition spreads
    // no keys and a true one spreads the right side entire, so the right side is the whole of it.
    const config = configOf(
      "export default { ...(isDev && { cacheComponents: true }), typedRoutes: true };\n",
    );
    expect(readFlagPresence(config, "basePath")).toEqual({ status: "resolved", value: false });
    expect(readFlagPresence(config, "cacheComponents").status).toBe("unresolved");

    const chained = configOf(
      "export default { ...(isDev && isServer && { cacheComponents: true }), typedRoutes: true };\n",
    );
    expect(readFlagPresence(chained, "basePath")).toEqual({ status: "resolved", value: false });

    const named = configOf(
      "const extra = { cacheComponents: true };\nexport default { ...(isDev && extra), typedRoutes: true };\n",
    );
    expect(readFlagPresence(named, "basePath")).toEqual({ status: "resolved", value: false });
  });

  it("should not read the keys of a logical and whose right side is unknowable", () => {
    const config = configOf("export default { ...(isDev && makeExtra()), typedRoutes: true };\n");
    expect(readFlagPresence(config, "basePath").status).toBe("unresolved");
  });

  it("should not read the keys of an or or a nullish coalesce", () => {
    // Both can spread their LEFT side, and which side they spread is not knowable without
    // evaluating it. `&&` is different only because its left side is never the value spread.
    const or = configOf(
      "export default { ...(extra || { basePath: '/x' }), typedRoutes: true };\n",
    );
    expect(readFlagPresence(or, "cacheComponents").status).toBe("unresolved");

    const nullish = configOf(
      "export default { ...(extra ?? { basePath: '/x' }), typedRoutes: true };\n",
    );
    expect(readFlagPresence(nullish, "cacheComponents").status).toBe("unresolved");
  });

  it("should read the keys of a base spread from a workspace package", () => {
    // `nakafaai/nakafa.com` writes `{ ...config, … }` with `config` from `@repo/next-config`.
    // The package states its own keys, so every option outside them is still absent — seven of
    // the twelve constraints fell on this one spread.
    const root = mkdtempSync(join(tmpdir(), "next-coverage-workspace-"));
    const packageDirectory = join(root, "base");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), '{ "name": "@repo/base" }');
    writeFileSync(
      join(packageDirectory, "index.ts"),
      "export const config = { typedRoutes: true, reactCompiler: true };\n",
    );
    writeFileSync(
      join(root, "next.config.ts"),
      "import { config } from '@repo/base';\nexport default { ...config, images: {} };\n",
    );
    const source = readNextConfig(root, (specifier) =>
      specifier === "@repo/base" ? packageDirectory : undefined,
    );

    expect(readFlagPresence(source, "basePath")).toEqual({ status: "resolved", value: false });
    expect(readFlagPresence(source, "redirects")).toEqual({ status: "resolved", value: false });
    // A key the package does state stays unresolved: the app spreads it, and what it holds is the
    // package's value rather than this project's.
    expect(readFlagPresence(source, "typedRoutes").status).toBe("unresolved");
    expect(readFlagPresence(source, "images")).toEqual({ status: "resolved", value: true });

    // Without a resolver the specifier names nothing this reader can open, and the spread hides
    // everything as it did before.
    const unresolvedSource = readNextConfig(root);
    expect(readFlagPresence(unresolvedSource, "basePath").status).toBe("unresolved");
  });

  it("should not take a package's keys for a name the config declares itself", () => {
    // The config imports `config` and then binds the same name to something of its own. What it
    // spreads is not reliably the import, and the package's keys are not this project's.
    const root = mkdtempSync(join(tmpdir(), "next-coverage-workspace-"));
    const packageDirectory = join(root, "base");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), '{ "name": "@repo/base" }');
    writeFileSync(
      join(packageDirectory, "index.ts"),
      "export const config = { typedRoutes: true };\n",
    );
    writeFileSync(
      join(root, "next.config.ts"),
      [
        "import { config } from '@repo/base';",
        "const config = buildConfig();",
        "export default { ...config };",
      ].join("\n"),
    );
    const source = readNextConfig(root, (specifier) =>
      specifier === "@repo/base" ? packageDirectory : undefined,
    );
    expect(readFlagPresence(source, "basePath").status).toBe("unresolved");
  });

  it("should leave readFlag answering with the value, unchanged", () => {
    const config = configOf("export default { typedRoutes: true, reactCompiler: false };\n");
    expect(readFlag(config, "typedRoutes")).toEqual({ status: "resolved", value: true });
    expect(readFlag(config, "reactCompiler")).toEqual({ status: "resolved", value: false });
    expect(readFlag(config, "absent")).toEqual({ status: "resolved" });
  });
});

describe("a property named but unreadable", () => {
  it("should count an option written as a method as present", () => {
    // `async headers() { … }` is a method declaration, not an assignment. The name is written
    // there, so the option is set; only its value is out of reach.
    const config = configOf("export default { async headers() { return []; } };\n");
    expect(readFlagPresence(config, "headers")).toEqual({ status: "resolved", value: true });
    expect(readFlag(config, "headers").status).toBe("unresolved");
  });

  it("should count a shorthand property as present", () => {
    const config = configOf("const images = {};\nexport default { images };\n");
    expect(readFlagPresence(config, "images")).toEqual({ status: "resolved", value: true });
  });

  it("should keep a spread with no matching property unresolved", () => {
    // The two used to give the same answer. A spread might carry the option or might not, and
    // calling that present would be the guess the requirement forbids.
    const config = configOf("export default { ...base, images: {} };\n");
    expect(readFlagPresence(config, "headers").status).toBe("unresolved");
    expect(readFlagPresence(config, "images")).toEqual({ status: "resolved", value: true });
  });

  it("should leave readFlag unresolved for every unreadable shape", () => {
    const method = configOf("export default { async headers() { return []; } };\n");
    const spread = configOf("export default { ...base };\n");
    expect(readFlag(method, "headers").status).toBe("unresolved");
    expect(readFlag(spread, "headers").status).toBe("unresolved");
  });
});

describe("array option contents", () => {
  it("should resolve the string literals of a list, in order", () => {
    const config = configOf("export default { serverExternalPackages: ['pg', 'sharp'] };\n");
    expect(readFlagList(config, "serverExternalPackages")).toEqual({
      status: "resolved",
      value: { values: ["pg", "sharp"], skipped: 0, branched: false },
    });
  });

  it("should count what it could not read instead of hiding it", () => {
    // A half-read list must not look complete: a name excluded from the reading would otherwise
    // be indistinguishable from a name that is not there.
    const config = configOf("export default { transpilePackages: ['a', SOME_CONST, 'b'] };\n");
    expect(readFlagList(config, "transpilePackages")).toEqual({
      status: "resolved",
      value: { values: ["a", "b"], skipped: 1, branched: false },
    });
  });

  it("should walk a dotted path to a nested list", () => {
    const config = configOf(
      "export default { experimental: { optimizePackageImports: ['lucide-react'] } };\n",
    );
    expect(readFlagList(config, "experimental.optimizePackageImports").status).toBe("resolved");
  });

  it("should separate a list nobody wrote from one it cannot read", () => {
    const absent = configOf("export default { typedRoutes: true };\n");
    expect(readFlagList(absent, "transpilePackages")).toEqual({
      status: "resolved",
      value: { values: [], skipped: 0, branched: false },
    });
    const notAList = configOf("export default { transpilePackages: someValue };\n");
    expect(readFlagList(notAList, "transpilePackages").status).toBe("unresolved");
  });

  it("should read a list one branch of a conditional writes", () => {
    // `voidcraft-labs/commcare-nova` turns the option on by environment this way, and reported
    // 11 of 13 constraints because the whole reading stopped at the conditional.
    const config = configOf(
      "export default { instrumentationClientInject: enabled ? ['./client.ts'] : [] };\n",
    );
    expect(readFlagList(config, "instrumentationClientInject")).toEqual({
      status: "resolved",
      value: { values: ["./client.ts"], skipped: 0, branched: true },
    });
  });

  it("should read the union of two branches that both write a list", () => {
    // Which branch runs is never decided here, so both contribute. A name written in either
    // branch is written, which is the question every reader of this list but one asks.
    const config = configOf("export default { transpilePackages: cond ? ['a'] : ['b'] };\n");
    expect(readFlagList(config, "transpilePackages")).toEqual({
      status: "resolved",
      value: { values: ["a", "b"], skipped: 0, branched: true },
    });
  });

  it("should count a computed element inside a branch rather than hiding it", () => {
    const config = configOf(
      "export default { transpilePackages: cond ? ['a', COMPUTED] : ['b'] };\n",
    );
    expect(readFlagList(config, "transpilePackages")).toEqual({
      status: "resolved",
      value: { values: ["a", "b"], skipped: 1, branched: true },
    });
  });

  it("should refuse the whole list when one branch is not a list", () => {
    // The mixed case, written before the reading was widened. A branch read cleanly must not make
    // its unreadable sibling disappear: half a list reported whole is the failure this counts
    // against, and `skipped` cannot express it because that branch has no known element count.
    const config = configOf("export default { transpilePackages: cond ? ['a'] : someValue };\n");
    expect(readFlagList(config, "transpilePackages").status).toBe("unresolved");
    const other = configOf("export default { transpilePackages: cond ? someValue : ['b'] };\n");
    expect(readFlagList(other, "transpilePackages").status).toBe("unresolved");
  });

  it("should refuse a branched list for pageExtensions", () => {
    // This list decides which files are route conventions. Reading the union of two branches
    // would make the route walk claim conventions in files the running branch does not serve.
    const branched = configOf(
      "export default { pageExtensions: mdx ? ['tsx', 'mdx'] : ['tsx'] };\n",
    );
    expect(readFlagList(branched, "pageExtensions").status).toBe("resolved");
    expect(readPageExtensions(branched).status).toBe("unresolved");
  });

  it("should keep pageExtensions all-or-nothing on top of it", () => {
    // A half-read extension list would make the route walk miss files, which is worse than
    // admitting the list could not be read.
    const partial = configOf("export default { pageExtensions: ['tsx', COMPUTED] };\n");
    expect(readPageExtensions(partial).status).toBe("unresolved");
    const clean = configOf("export default { pageExtensions: ['tsx', 'mdx'] };\n");
    expect(readPageExtensions(clean)).toEqual({ status: "resolved", value: ["tsx", "mdx"] });
  });
});

describe("a configuration assigned to module.exports", () => {
  /**
   * The form a real project writes in a TypeScript config, and the reader had no branch for it.
   * Every option it set read as unresolved, which the catalog cannot tell from absent, so the
   * report argued for `inlineCss` against a project whose configuration already turned it on.
   */
  it("should read it the same way it reads an export default", () => {
    const commonJs = configOf(`${BODY}\nmodule.exports = nextConfig;\n`);
    const esm = configOf(`${BODY}\nexport default nextConfig;\n`);
    expect(readFlag(commonJs, "typedRoutes")).toEqual(readFlag(esm, "typedRoutes"));
    expect(readFlag(commonJs, "experimental.taint")).toEqual(readFlag(esm, "experimental.taint"));
    expect(readFlag(commonJs, "typedRoutes")).toEqual(resolved(true));
  });

  /** What CommonJS does at runtime: the last assignment is the one the file exports. */
  it("should read the last assignment where there is more than one", () => {
    const config = configOf(
      "module.exports = { typedRoutes: false };\nmodule.exports = { typedRoutes: true };\n",
    );
    expect(readFlag(config, "typedRoutes")).toEqual(resolved(true));
  });

  /** A file carrying both is ambiguous, and the documentation writes every config the ES way. */
  it("should prefer an export default where the file has both", () => {
    const config = configOf(
      "export default { typedRoutes: true };\nmodule.exports = { typedRoutes: false };\n",
    );
    expect(readFlag(config, "typedRoutes")).toEqual(resolved(true));
  });

  it("should unwrap a plugin wrapper the same way", () => {
    const config = configOf(`${BODY}\nmodule.exports = withMDX(nextConfig);\n`);
    expect(readFlag(config, "typedRoutes")).toEqual(resolved(true));
  });

  it("should read a function assigned to it for what it returns", () => {
    const config = configOf(
      `${BODY}\nmodule.exports = function config() { return nextConfig; };\n`,
    );
    expect(readFlag(config, "typedRoutes")).toEqual(resolved(true));
  });

  /**
   * A partial or differently-named CommonJS export is a different claim about what the file
   * exports. Reading one would be guessing at a shape rather than measuring it.
   */
  it.each([["module.exports.default"], ["exports.default"], ["exports"]])(
    "should leave the config unresolved for %s",
    (form) => {
      const config = configOf(`${BODY}\n${form} = nextConfig;\n`);
      expect(config?.object.status).toBe("unresolved");
    },
  );

  it("should name both forms when neither is found", () => {
    const config = configOf(`${BODY}\n`);
    expect(config?.object.status).toBe("unresolved");
    const reason = config?.object.status === "unresolved" ? config.object.reason : "";
    expect(reason).toContain("default export");
    expect(reason).toContain("module.exports");
  });
});
