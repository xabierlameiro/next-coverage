import { describe, expect, it } from "vitest";
import { spellControls, spellingControls } from "./control-characters.js";

describe("text a terminal would act on", () => {
  it("should leave text holding no control character as it was", () => {
    expect(spellControls("app/[slug]/page.tsx → lib/données.ts")).toBe(
      "app/[slug]/page.tsx → lib/données.ts",
    );
  });

  it("should write an escape out rather than let it start a sequence", () => {
    expect(spellControls("app/\u001b[2Kpage.tsx")).toBe("app/\\u001b[2Kpage.tsx");
  });

  /** The two that forge a line: one starts it, the other overwrites the one being written. */
  it("should write a line feed and a carriage return out", () => {
    expect(spellControls("a\nb\rc")).toBe("a\\u000ab\\u000dc");
  });

  it("should write out the delete character and the second control block", () => {
    expect(spellControls("a\u007fb\u009bc")).toBe("a\\u007fb\\u009bc");
  });

  it("should write out a control that reorders the text around it", () => {
    expect(spellControls("page\u202excod.ts")).toBe("page\\u202excod.ts");
  });
});

describe("a value about to be printed", () => {
  it("should respell the strings at every depth and keep the shape", () => {
    const given = {
      count: 2,
      absent: undefined,
      flag: true,
      entries: [{ evidence: ["app/\u001b[1Apage.tsx"], reached: new Set(["lib/\na.ts"]) }],
      byPath: new Map([["k\u0007", { note: "fine" }]]),
    };
    expect(spellingControls(given)).toEqual({
      count: 2,
      absent: undefined,
      flag: true,
      entries: [{ evidence: ["app/\\u001b[1Apage.tsx"], reached: new Set(["lib/\\u000aa.ts"]) }],
      byPath: new Map([["k\\u0007", { note: "fine" }]]),
    });
  });

  it("should respell a key, which a path can be", () => {
    expect(spellingControls({ "app/\u001bx": 1 })).toEqual({ "app/\\u001bx": 1 });
  });

  it("should not change what it was given", () => {
    const given = { evidence: ["a\u001bb"] };
    spellingControls(given);
    expect(given.evidence).toEqual(["a\u001bb"]);
  });
});
