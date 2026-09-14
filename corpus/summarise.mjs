#!/usr/bin/env node
// summarise.mjs <work-dir>
//
// Turns a directory of probe output into the comparisons a pass is run for: what each bucket holds,
// which catalog ids argue under each preset, and which never argue at all.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const work = process.argv[2];
if (!work) {
  console.error("usage: summarise.mjs <work-dir>");
  process.exit(64);
}
const dir = join(work, "out");

/** Reads one JSON report, or nothing where the probe wrote `{}` for a project it could not analyse. */
function report(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed.entries) && parsed.entries.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const buckets = {};
const perId = {};
const defaultArgues = new Set();
let analysed = 0;
let silent = 0;
let contradictions = 0;
const lowConstraints = [];

for (const file of readdirSync(dir).filter((name) => name.endsWith(".strict.json"))) {
  const slug = file.replace(/\.strict\.json$/, "");
  const strict = report(join(dir, file));
  if (!strict) {
    silent += 1;
    continue;
  }
  analysed += 1;

  // `checked` and `contradicted` are NUMBERS. Reading either as an array reports zero across every
  // project and says nothing about it: `Number.length` is undefined, and `?? 0` turns that into a
  // clean-looking zero. That reading once claimed 21 projects contradicted nothing.
  const checked = strict.constraints?.checked ?? 0;
  const contradicted = strict.constraints?.contradicted ?? 0;
  contradictions += contradicted;
  if (checked < 13) lowConstraints.push(`${slug} (${checked})`);

  for (const entry of strict.entries) {
    buckets[entry.bucket] = (buckets[entry.bucket] || 0) + 1;
    perId[entry.id] ||= { used: 0, wouldApply: 0, evidence: 0 };
    if (entry.bucket === "used") perId[entry.id].used += 1;
    if (entry.bucket === "would-apply") {
      perId[entry.id].wouldApply += 1;
      perId[entry.id].evidence += (entry.evidence || []).length;
    }
  }

  const byDefault = report(join(dir, `${slug}.json`));
  for (const entry of byDefault?.entries ?? []) {
    if (entry.bucket === "would-apply") defaultArgues.add(entry.id);
  }
}

const ids = Object.keys(perId).sort();
const arguesUnderStrict = ids.filter((id) => perId[id].wouldApply > 0);

console.log(`analysed ${analysed} projects, ${silent} produced no entries`);
console.log(`\nbuckets (strict):`);
for (const [bucket, count] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${bucket.padEnd(16)} ${count}`);
}

// The comparison this exists for. A pass measuring only the default preset made 51 conditions look
// dead when a flag was withholding them, and the figure that revealed it is this pair.
console.log(`\ncatalog ids: ${ids.length}`);
console.log(`ids arguing under the default preset: ${defaultArgues.size}`);
console.log(`ids arguing under --strict:           ${arguesUnderStrict.length}`);

const strictOnly = arguesUnderStrict.filter((id) => !defaultArgues.has(id));
console.log(`\nids that argue only under --strict (${strictOnly.length}):`);
for (const id of strictOnly.sort((a, b) => perId[b].wouldApply - perId[a].wouldApply)) {
  const { wouldApply, evidence } = perId[id];
  // Evidence per project separates a condition anchored in files that exist from one arguing from
  // absence, which is what decides whether a fire count means anything.
  console.log(
    `  ${String(wouldApply).padStart(4)}  ${(evidence / wouldApply).toFixed(1).padStart(6)} ev/proj  ${id}`,
  );
}

const never = ids.filter((id) => perId[id].used === 0 && perId[id].wouldApply === 0);
console.log(`\nids never used and never arguing (${never.length}):`);
for (const id of never) console.log(`  ${id}`);

console.log(`\ncontradictions across the pass: ${contradictions}`);
if (lowConstraints.length > 0) {
  console.log(`projects below 13 constraints checked: ${lowConstraints.join(", ")}`);
}
