import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveSurface, documentsInstruction } from "./docs.js";

describe("degraded path", () => {
  it("should report unavailable when there is no installed package", () => {
    const derivation = deriveSurface(undefined);
    expect(derivation.status).toBe("unavailable");
  });
});

describe("an instruction read from the documentation that shipped", () => {
  it("should answer false rather than throw when the page is not there", () => {
    // A package that shipped no docs must not fail an analysis; it must make no claim.
    expect(documentsInstruction(join("/", "no", "such", "page.md"), "anything")).toBe(false);
  });
});
