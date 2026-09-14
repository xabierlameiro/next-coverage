import { describe, expect, it } from "vitest";
import { fixtureContext, VENDORED } from "../../test-support/corpus.js";
import { FIXTURES, fixtureAvailable, okAnalysis } from "../../test-support/fixtures.js";
import type { SurfaceEntry } from "../collect/docs.js";
import { ALL_PREDICATES } from "./build.js";

/**
 * The cheap half of the register rule. A gain states what the framework does once the API is in
 * place; it never says the code should change, that the current shape is wrong, or how much the
 * change is worth. The words below are the ones a sentence slips into when it starts to advise,
 * and catching them here is cheaper than a reader meeting them in a report. `error` is absent on
 * purpose: a convention is named after it.
 */
const OUT_OF_REGISTER = [
  "should",
  "must",
  "wrong",
  "bad ",
  "fix ",
  "critical",
  "severe",
  "warning",
  "always",
  "never",
];

function offences(gain: string): string[] {
  const lower = gain.toLowerCase();
  return OUT_OF_REGISTER.filter((word) => lower.includes(word));
}

/** The surface entry a predicate receives. Only its id and title are read by one. */
function surfaceOf(id: string): SurfaceEntry {
  return {
    id,
    domain: "file-conventions",
    title: id.split("/").at(-1) ?? "",
    relatedLinks: [],
    docPath: `/docs/${id}.md`,
    docRelativePath: "",
    docUrl: "",
    frontmatterFailed: false,
    adoptable: true,
  };
}

describe("the gain a condition carries", () => {
  it("should fail on a sentence that advises rather than states", () => {
    expect(offences("you should fix this, it is wrong")).toEqual(["should", "wrong", "fix "]);
    expect(offences("Image serves each one resized to the viewport")).toEqual([]);
  });

  // Every condition that fires on a vendored project carries a gain in register. The type
  // already requires one; this reads what was written. One project may hold nothing that fires
  // — the overconfigured one is built to keep its flagged conditions silent — so the count that
  // has to be non-zero is across the corpus, not per fixture.
  it("should stay in register on every condition firing against a vendored project", () => {
    const seen: string[] = [];
    for (const fixture of VENDORED) {
      const context = fixtureContext(fixture);
      for (const predicates of ALL_PREDICATES) {
        const surface = surfaceOf(predicates.id);
        for (const condition of [predicates.wouldApply, predicates.wouldApplyStrict]) {
          if (condition === undefined) continue;
          const verdict = condition(context, surface);
          if (!verdict.matched) continue;
          seen.push(predicates.id);
          expect(verdict.gain.length, `${predicates.id} carries an empty gain`).toBeGreaterThan(0);
          expect(offences(verdict.gain), `${predicates.id}: ${verdict.gain}`).toEqual([]);
        }
      }
    }
    expect(new Set(seen).size).toBeGreaterThan(20);
  });

  const referenced = FIXTURES.filter(fixtureAvailable);
  it.skipIf(referenced.length === 0).each(referenced)(
    "should stay in register on every suggestion $name makes under strict",
    (fixture) => {
      const { result } = okAnalysis(fixture, "strict");
      for (const entry of result.entries) {
        const gains = [entry.gain, entry.alsoWouldApply?.gain].filter(
          (gain): gain is string => gain !== undefined,
        );
        for (const gain of gains) {
          expect(offences(gain), `${entry.id}: ${gain}`).toEqual([]);
        }
        if (entry.bucket === "would-apply") expect(entry.gain).toBeDefined();
        if (entry.bucket !== "would-apply") expect(entry.gain).toBeUndefined();
      }
    },
  );
});
