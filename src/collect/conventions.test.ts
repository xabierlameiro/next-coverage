import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_EXTENSIONS, resolved, unresolved } from "../types.js";
import { conventionOf, proxyFiles } from "./conventions.js";

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

describe("which file names a metadata convention", () => {
  const extensions = DEFAULT_PAGE_EXTENSIONS;

  it.each([
    ["sitemap.xml", "sitemap"],
    ["sitemap.ts", "sitemap"],
    ["robots.txt", "robots"],
    ["manifest.webmanifest", "manifest"],
    ["manifest.json", "manifest"],
    ["icon.svg", "icon"],
    ["apple-icon.png", "apple-icon"],
    ["opengraph-image.gif", "opengraph-image"],
    ["twitter-image.tsx", "twitter-image"],
  ])("should read %s as the convention", (fileName, name) => {
    expect(conventionOf(fileName, extensions)).toEqual({ name, casingMismatch: false });
  });

  it.each([
    "sitemap.txt",
    "robots.xml",
    "manifest.yaml",
    "apple-icon.svg",
    "opengraph-image.svg",
    "icon.md",
  ])("should not read %s as a convention, because Next.js does not", (fileName) => {
    expect(conventionOf(fileName, extensions)).toBeUndefined();
  });

  it("should read the numbered files a segment holds several of", () => {
    expect(conventionOf("icon1.png", extensions)).toEqual({ name: "icon", casingMismatch: false });
    expect(conventionOf("opengraph-image2.tsx", extensions)).toEqual({
      name: "opengraph-image",
      casingMismatch: false,
    });
  });

  it("should not number a convention that takes no number", () => {
    expect(conventionOf("page1.tsx", extensions)).toBeUndefined();
    expect(conventionOf("sitemap1.xml", extensions)).toBeUndefined();
    expect(conventionOf("icon12.png", extensions)).toBeUndefined();
  });

  it("should report wrong casing on a metadata file that is not code", () => {
    expect(conventionOf("Robots.txt", extensions)).toEqual({
      name: "robots",
      casingMismatch: true,
    });
    expect(conventionOf("Icon.png", extensions)).toEqual({ name: "icon", casingMismatch: true });
  });

  it("should read a metadata file written in an extension the project added", () => {
    expect(conventionOf("sitemap.mdx", ["tsx", "mdx"])).toEqual({
      name: "sitemap",
      casingMismatch: false,
    });
  });
});
