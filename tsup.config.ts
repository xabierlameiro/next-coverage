import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// The CLI answers `--version` from this, rather than reading the manifest at run time: that would
// tie it to where the file sits relative to `dist/`, and do file I/O for an answer the build had.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node20",
  // tsup forces `baseUrl` on the declaration build (`compilerOptions.baseUrl || "."`), and
  // TypeScript 6 rejects that option as deprecated with TS5101. This tsconfig never sets
  // `baseUrl`, so the silencing is confined to the step that injects it. Drop it once tsup
  // stops forcing the option.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  define: { __VERSION__: JSON.stringify(version) },
});
