/**
 * A bench, not a test. It runs the real config reader over a directory of `next.config` files taken
 * from real projects and reports which ones it could not resolve.
 *
 * It exists because `readNextConfig` takes a path and never file content, so measuring how many
 * shapes the reader handles needs a directory holding the file and nothing else — no clone, no
 * install, no `node_modules`. That makes it around a thousand times cheaper than a corpus pass:
 * 856 configs in roughly 400ms against hours and gigabytes for the same question. The two reader
 * bugs that motivated it were found here and only then confirmed through the harness.
 *
 * Not named `*.test.ts` on purpose: the root vitest config collects every `*.test.ts` in the
 * repository, and this one fails without `BENCH_DIR`. It is run through `config-bench.config.ts`,
 * which names it explicitly. See the *Config bench* section of `README.md` for how to drive it.
 *
 * `BENCH_DIR` points at a directory of `<slug>/next.config.*` subdirectories, which
 * `fetch-configs.sh` writes. `BENCH_REPORT` is where the TSV goes.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { readNextConfig } from "../src/collect/config.js";

const BENCH_DIR = process.env.BENCH_DIR ?? "";
const REPORT = process.env.BENCH_REPORT ?? `${process.env.TMPDIR}/config-bench.tsv`;

it("reads every fetched config, and reports the ones it cannot", () => {
  if (BENCH_DIR === "")
    throw new Error("set BENCH_DIR to a directory of <slug>/next.config.* dirs");

  const slugs = readdirSync(BENCH_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const rows: string[] = [];
  for (const slug of slugs) {
    const dir = join(BENCH_DIR, slug);
    let verdict: string;
    let detail = "";
    // A throw is the one verdict that is always a defect: the reader is handed a file it did not
    // write and must answer, never raise. Caught here so one bad config cannot end the pass.
    try {
      const source = readNextConfig(dir);
      if (source === undefined) {
        verdict = "NO_SOURCE";
      } else if (source.object.status === "unresolved") {
        verdict = "UNRESOLVED";
        detail = source.object.reason;
      } else {
        verdict = "RESOLVED";
        detail = String(source.object.value.properties.length);
      }
    } catch (error) {
      verdict = "THREW";
      detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    rows.push(`${verdict}\t${slug}\t${detail}`);
  }

  writeFileSync(REPORT, `${rows.join("\n")}\n`, "utf8");
  const counts = new Map<string, number>();
  for (const row of rows) {
    const verdict = row.split("\t")[0] ?? "?";
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }
  console.log(`bench dir: ${BENCH_DIR}`);
  console.log(`configs: ${rows.length}`);
  for (const [verdict, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${verdict}: ${count}`);
  }
  console.log(`report: ${REPORT}`);
});
