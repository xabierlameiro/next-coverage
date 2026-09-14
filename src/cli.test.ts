import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "./cli-args.js";

const CLI = join(process.cwd(), "dist", "cli.js");

/**
 * Run against the built CLI rather than an exported function: the exit status, the stream a line
 * lands on and the `--version` the build inlines are all properties of the binary, and testing
 * around it would test something else.
 */
function run(...args: readonly string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  const built = spawnSync(join("node_modules", ".bin", "tsup"), [], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`the build failed:\n${built.stderr}`);
  if (!existsSync(CLI)) throw new Error(`the build produced no ${CLI}`);
}, 120_000);

describe("describing itself", () => {
  it("should print the version from the manifest and analyse nothing", () => {
    const { status, stdout } = run("--version");
    expect(status).toBe(EXIT.ok);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("should print help listing the flags and the exit statuses", () => {
    const { status, stdout } = run("--help");
    expect(status).toBe(EXIT.ok);
    for (const flag of ["--strict", "--findings", "--json", "--help", "--version"])
      expect(stdout).toContain(flag);
    for (const code of Object.values(EXIT)) expect(stdout).toContain(String(code));
  });

  it("should show help rather than analyse when given a directory too", () => {
    const { status, stdout } = run("--help", process.cwd());
    expect(status).toBe(EXIT.ok);
    expect(stdout).toContain("Usage:");
    expect(stdout).not.toContain("would apply");
  });
});

describe("refusing a wrong invocation", () => {
  it("should refuse a single-dash flag on stderr, writing nothing to stdout", () => {
    const { status, stdout, stderr } = run("-h");
    expect(status).toBe(EXIT.usage);
    expect(stdout).toBe("");
    expect(stderr).toContain("-h");
  });

  it("should refuse a misspelled long flag", () => {
    const { status, stderr } = run("--jsonn");
    expect(status).toBe(EXIT.usage);
    expect(stderr).toContain("--jsonn");
  });

  it("should refuse two directories", () => {
    const { status, stderr } = run(".", "..");
    expect(status).toBe(EXIT.usage);
    expect(stderr).toContain("one directory");
  });

  it("should refuse --findings alongside --json, naming both and analysing nothing", () => {
    const { status, stdout, stderr } = run(".", "--findings", "--json");
    expect(status).toBe(EXIT.usage);
    expect(stdout).toBe("");
    expect(stderr).toContain("--findings");
    expect(stderr).toContain("--json");
  });
});

describe("when there is nothing to analyse", () => {
  it("should explain on stderr and exit non-zero, with stdout empty", () => {
    const empty = mkdtempSync(join(tmpdir(), "next-coverage-none-"));
    const { status, stdout, stderr } = run(empty);
    expect(status).toBe(EXIT.nothingToAnalyse);
    expect(stdout).toBe("");
    expect(stderr).toContain("No Next.js project");
  });

  it("should say so when the project has no App Router", () => {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-pages-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.3.0" } }));
    const { status, stdout, stderr } = run(root);
    expect(status).toBe(EXIT.nothingToAnalyse);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
  });
});

describe("when no surface could be derived", () => {
  /** A project the tool can find and walk, with no installed release to derive a surface from. */
  function projectWithoutNext(): string {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-nonext-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.3.0" } }));
    mkdirSync(join(root, "app"));
    writeFileSync(
      join(root, "app", "page.tsx"),
      "export default function Page() {\n  return null;\n}\n",
    );
    return root;
  }

  it("should write the report it produced and exit under its own status", () => {
    const { status, stdout } = run(projectWithoutNext());
    expect(status).toBe(EXIT.surfaceUnavailable);
    expect(stdout).toContain("Surface could not be derived");
  });

  it("should return the same status under --json, which is a fact about the run", () => {
    const { status, stdout } = run(projectWithoutNext(), "--json");
    expect(status).toBe(EXIT.surfaceUnavailable);
    const parsed = JSON.parse(stdout) as { surfaceUnavailable: string | null; entries: unknown[] };
    expect(parsed.surfaceUnavailable).toEqual(expect.any(String));
    expect(parsed.entries).toEqual([]);
  });

  it("should return the same status under --findings", () => {
    expect(run(projectWithoutNext(), "--findings").status).toBe(EXIT.surfaceUnavailable);
  });

  /**
   * The defect this status exists for: without it, the two runs below differ only in a line of
   * prose, and a caller reading the status alone cannot tell them apart.
   */
  it("should not share a status with a project that could not be analysed at all", () => {
    const analysable = run(projectWithoutNext());
    const unanalysable = run(mkdtempSync(join(tmpdir(), "next-coverage-none-")));
    expect(unanalysable.status).toBe(EXIT.nothingToAnalyse);
    expect(unanalysable.stdout).toBe("");
    expect(analysable.status).not.toBe(unanalysable.status);
    expect(analysable.stdout.length).toBeGreaterThan(0);
  });

  /** Declared to be two encodings of one result, so the reason cannot differ between them. */
  it("should state the identical reason in both encodings", () => {
    const root = projectWithoutNext();
    const reason = (JSON.parse(run(root, "--json").stdout) as { surfaceUnavailable: string })
      .surfaceUnavailable;
    expect(run(root).stdout).toContain(reason);
    expect(run(root, "--findings").stdout).toContain(reason);
  });
});

describe("when the directory is a workspace root", () => {
  it("should name the member apps on stderr and exit non-zero, with stdout empty", () => {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-mono-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true }));
    for (const name of ["admin", "donor"]) {
      mkdirSync(join(root, "apps", name, "app"), { recursive: true });
      writeFileSync(
        join(root, "apps", name, "package.json"),
        JSON.stringify({ name, dependencies: { next: "16.3.0" } }),
      );
      writeFileSync(
        join(root, "apps", name, "app", "page.tsx"),
        "export default function P() {}\n",
      );
    }
    const { status, stdout, stderr } = run(root);
    expect(status).toBe(EXIT.nothingToAnalyse);
    expect(stdout).toBe("");
    expect(stderr).toContain("is a workspace root, not a project");
    expect(stderr).toContain(join("apps", "admin"));
    expect(stderr).toContain(join("apps", "donor"));
  });
});

describe("when the directory declares nothing but holds an app below it", () => {
  it("should name the app on stderr and exit non-zero, with stdout empty", () => {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-undeclared-"));
    mkdirSync(join(root, "frontend", "app"), { recursive: true });
    writeFileSync(
      join(root, "frontend", "package.json"),
      JSON.stringify({ name: "frontend", dependencies: { next: "16.3.4" } }),
    );
    writeFileSync(join(root, "frontend", "app", "page.tsx"), "export default function P() {}\n");
    const { status, stdout, stderr } = run(root);
    expect(status).toBe(EXIT.nothingToAnalyse);
    expect(stdout).toBe("");
    expect(stderr).toContain("No Next.js project at");
    expect(stderr).toContain("frontend");
    expect(stderr).not.toContain("workspace root");
  });
});
