import { describe, expect, it } from "vitest";
import { TAG_SURFACE } from "../collect/ledger.js";

function unclassified(symbols: readonly string[]): string[] {
  const known = new Set<string>([
    ...TAG_SURFACE.producers,
    ...TAG_SURFACE.consumers,
    ...Object.keys(TAG_SURFACE.withoutTags),
  ]);
  return symbols.filter((symbol) => !known.has(symbol));
}

describe("the documented tag surface", () => {
  it("should name a function the documentation adds and nobody classified", () => {
    // The failure the guard exists for, built rather than waited for.
    expect(unclassified(["cacheTag", "expireTag"])).toEqual(["expireTag"]);
  });

  it("should state a reason for every function it says carries no tags", () => {
    const reasons = Object.values(TAG_SURFACE.withoutTags);
    expect(reasons.every((reason) => reason.length > 20)).toBe(true);
  });
});
