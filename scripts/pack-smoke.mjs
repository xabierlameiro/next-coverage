#!/usr/bin/env node
/**
 * Release gate: pack the real tarball, install it in a clean directory, and analyse a vendored app
 * with the INSTALLED binary, against a Next.js installed the way a user's project has it. If this
 * passes, the published package works for a stranger running `npx next-coverage`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (command, args, cwd = root) => execFileSync(command, args, { stdio: "inherit", cwd });

function fail(message) {
  console.error(`✖ pack smoke FAILED: ${message}`);
  process.exit(1);
}

console.log("· building and packing");
run("pnpm", ["build"]);
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "next-coverage-pack-"));
// Lifecycle scripts write to the same stdout as the JSON payload, so parsing starts at the array.
const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
  cwd: root,
}).toString();
const tarball = join(work, JSON.parse(packOutput.slice(packOutput.indexOf("[")))[0].filename);

console.log("· installing the tarball into a clean directory");
const install = join(work, "install");
run("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", install, tarball], work);
const binary = join(install, "node_modules", ".bin", "next-coverage");

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const printed = execFileSync(binary, ["--version"]).toString().trim();
if (printed !== version) fail(`--version printed ${printed}, package.json says ${version}`);

console.log("· installing Next.js into a copy of a vendored app");
const app = join(work, "app");
cpSync(join(root, "test-support", "sparse-app"), app, { recursive: true });
const { dependencies } = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
// Peers are not resolved: the fixture declares only what the tool reads, and the tool reads the
// documentation `next` ships, not a runnable app.
run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--legacy-peer-deps"], app);

console.log("· analysing it with the installed binary");
const analysis = spawnSync(binary, [app, "--json"], { encoding: "utf8" });
if (analysis.status !== 0) fail(`exit status ${analysis.status}\n${analysis.stderr}`);
const report = JSON.parse(analysis.stdout);
if (report.nextVersion !== dependencies.next) {
  fail(`analysed Next.js ${report.nextVersion}, the app installs ${dependencies.next}`);
}
if (!Array.isArray(report.entries) || report.entries.length === 0)
  fail("the report has no entries");

console.log(
  `✔ pack smoke passed: ${report.entries.length} entries on Next.js ${report.nextVersion}`,
);
