import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// The CLI answers `--version` from this, rather than reading the manifest at run time: that would
// tie it to where the file sits relative to `dist/`, and do file I/O for an answer the build had.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  define: { __VERSION__: JSON.stringify(version) },
});
