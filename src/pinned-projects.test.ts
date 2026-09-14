import { join } from "node:path";
import { describe, expect } from "vitest";
import {
  eachFixture,
  type Fixture,
  okAnalysis,
  PUBLIC_FIXTURES,
} from "../test-support/fixtures.js";
import type { Preset } from "./index.js";
import { serialiseReport } from "./report/serialise.js";

/**
 * What the tool reports on each pinned public project, held to a committed snapshot.
 *
 * A snapshot tests less than a hand-written assertion and catches more: any entry that changes
 * bucket, and any file a suggestion starts or stops citing, shows up in review as a diff. It is a
 * summary rather than the JSON so the diff stays readable: every entry's bucket, the files a
 * suggestion cites, and how many files a used entry was found in.
 *
 * Update with `pnpm vitest run src/pinned-projects.test.ts -u`, and commit the update on its own so
 * the diff is read rather than waved through.
 */
const SNAPSHOTS = join(import.meta.dirname, "..", "test-support", "snapshots");

function summary(fixture: Fixture, preset: Preset): string {
  const analysis = okAnalysis(fixture, preset);
  const report = serialiseReport(analysis.result, {
    colour: false,
    version: analysis.version,
    projectRoot: analysis.projectRoot,
  });
  const lines = [
    `next ${report.nextVersion ?? "unresolved"}, preset ${report.preset}`,
    `constraints checked ${report.constraints.checked}, contradicted ${report.constraints.contradicted}`,
    "",
  ];
  for (const entry of report.entries) {
    if (entry.bucket === "used") {
      lines.push(`used ${entry.id} (${entry.evidence.length})`);
    } else if (entry.bucket === "would-apply") {
      lines.push(`would-apply ${entry.id}`, ...entry.evidence.map((file) => `  ${file}`));
    } else {
      lines.push(`${entry.bucket} ${entry.id}`);
    }
    if (entry.alsoWouldApply !== undefined) {
      lines.push(
        `  also would apply`,
        ...entry.alsoWouldApply.evidence.map((file) => `    ${file}`),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

describe("the reports on the pinned public projects", () => {
  for (const preset of ["default", "strict"] as const) {
    eachFixture(PUBLIC_FIXTURES)(
      `should match the ${preset} snapshot of $fixture.name`,
      async ({ fixture }) => {
        await expect(summary(fixture, preset)).toMatchFileSnapshot(
          join(SNAPSHOTS, `${fixture.name}.${preset}.txt`),
        );
      },
    );
  }
});
