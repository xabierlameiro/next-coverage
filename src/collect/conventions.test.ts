import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_EXTENSIONS, resolved, unresolved } from "../types.js";
import { proxyFiles } from "./conventions.js";

describe("where a proxy file may sit", () => {
  /**
   * The defect this derivation closes: the candidates were four names ending in `.ts` and `.js`,
   * so a project whose proxy was `src/proxy.tsx` — an extension the documented default already
   * includes — was reported as having no proxy at all, in every reader that asks.
   */
  it("should offer both roots for every documented default extension", () => {
    const candidates = proxyFiles(resolved(DEFAULT_PAGE_EXTENSIONS));
    expect(candidates).toHaveLength(DEFAULT_PAGE_EXTENSIONS.length * 2);
    expect(candidates).toContainEqual(["src", "proxy.tsx"]);
    expect(candidates).toContainEqual(["proxy.tsx"]);
    expect(candidates).toContainEqual(["proxy.ts"]);
  });

  it("should offer only the extensions the project resolves", () => {
    const candidates = proxyFiles(resolved(["ts", "tsx"]));
    expect(candidates).toEqual([
      ["proxy.ts"],
      ["src", "proxy.ts"],
      ["proxy.tsx"],
      ["src", "proxy.tsx"],
    ]);
  });

  /** A custom list is the whole list: an extension it leaves out is one Next.js would not look for. */
  it("should leave out an extension the project's own list does not name", () => {
    const candidates = proxyFiles(resolved(["mdx", "tsx"]));
    expect(candidates).toContainEqual(["proxy.tsx"]);
    expect(candidates).not.toContainEqual(["proxy.ts"]);
  });

  /** The same fallback route tree construction applies, so the two cannot disagree about a default. */
  it("should fall back to the documented default where the value could not be read", () => {
    expect(proxyFiles(unresolved("computed at runtime"))).toEqual(
      proxyFiles(resolved(DEFAULT_PAGE_EXTENSIONS)),
    );
  });
});
