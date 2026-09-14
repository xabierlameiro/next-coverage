import { describe, expect, it } from "vitest";
import { EXIT, EXIT_DESCRIPTIONS, parseArgs, renderHelp, statusFor } from "./cli-args.js";

const CWD = "/somewhere";

describe("parsing the invocation", () => {
  it("should analyse the working directory when given no argument", () => {
    expect(parseArgs([], CWD)).toEqual({
      kind: "analyse",
      target: CWD,
      preset: "default",
      json: false,
      findings: false,
    });
  });

  it("should take a positional argument as the directory", () => {
    expect(parseArgs(["../other"], CWD)).toMatchObject({ kind: "analyse", target: "../other" });
  });

  it("should select the strict preset", () => {
    expect(parseArgs(["--strict"], CWD)).toMatchObject({ kind: "analyse", preset: "strict" });
  });

  it("should compose the flags with a directory", () => {
    expect(parseArgs(["--json", "app", "--strict"], CWD)).toEqual({
      kind: "analyse",
      target: "app",
      preset: "strict",
      json: true,
      findings: false,
    });
  });
});

describe("refusing what it does not understand", () => {
  /**
   * Both were live failures. The previous parser tested `startsWith("--")`, so `-h` was not a flag
   * to it and became the directory; and an unknown `--flag` was dropped, so a misspelled `--json`
   * produced a rendered report and a zero status.
   */
  it("should refuse a single-dash flag rather than analysing a directory named for it", () => {
    const parsed = parseArgs(["-h"], CWD);
    expect(parsed.kind).toBe("usage-error");
    expect(parsed.kind === "usage-error" && parsed.message).toContain("-h");
  });

  it("should refuse a misspelled long flag rather than dropping it", () => {
    const parsed = parseArgs(["--jsonn"], CWD);
    expect(parsed.kind).toBe("usage-error");
    expect(parsed.kind === "usage-error" && parsed.message).toContain("--jsonn");
  });

  it("should refuse two directories rather than choosing one", () => {
    const parsed = parseArgs(["one", "two"], CWD);
    expect(parsed.kind).toBe("usage-error");
    if (parsed.kind !== "usage-error") throw new Error("expected a usage error");
    expect(parsed.message).toContain("one");
    expect(parsed.message).toContain("two");
  });

  /**
   * The only pair of flags that cannot both be honoured. Refused rather than ranked: the JSON
   * already carries every channel the findings view reads, so which of the two was meant is not
   * decidable, and answering one of them silently is the same failure as dropping `--jsonn`.
   */
  it("should refuse a shortened report and a machine-readable one at once, naming both", () => {
    const parsed = parseArgs(["--findings", "--json"], CWD);
    expect(parsed.kind).toBe("usage-error");
    if (parsed.kind !== "usage-error") throw new Error("expected a usage error");
    expect(parsed.message).toContain("--findings");
    expect(parsed.message).toContain("--json");
  });

  it("should refuse them in either order", () => {
    expect(parseArgs(["--json", "--findings"], CWD).kind).toBe("usage-error");
  });
});

describe("asking for the findings only", () => {
  it("should carry the flag through to the analysis", () => {
    expect(parseArgs(["--findings"], CWD)).toEqual({
      kind: "analyse",
      target: CWD,
      preset: "default",
      json: false,
      findings: true,
    });
  });

  it("should compose with the strict preset and a directory", () => {
    expect(parseArgs(["--strict", "app", "--findings"], CWD)).toEqual({
      kind: "analyse",
      target: "app",
      preset: "strict",
      json: false,
      findings: true,
    });
  });

  it("should stay off when it is not asked for", () => {
    expect(parseArgs(["--strict"], CWD)).toMatchObject({ findings: false });
  });
});

describe("describing itself", () => {
  it("should answer --help without analysing anything", () => {
    expect(parseArgs(["--help"], CWD)).toEqual({ kind: "help" });
  });

  it("should answer --version without analysing anything", () => {
    expect(parseArgs(["--version"], CWD)).toEqual({ kind: "version" });
  });

  it("should show help rather than analyse when a directory is given alongside it", () => {
    expect(parseArgs(["--help", "app"], CWD)).toEqual({ kind: "help" });
  });

  it("should list every flag it accepts", () => {
    const help = renderHelp("1.2.3");
    for (const flag of ["--strict", "--json", "--help", "--version"]) {
      expect(help).toContain(flag);
    }
    expect(help).toContain("1.2.3");
  });

  /** So the help cannot fall behind the statuses the CLI actually returns. */
  it("should list every exit status the CLI can return", () => {
    const help = renderHelp("1.2.3");
    const listed = new Set(EXIT_DESCRIPTIONS.map((entry) => entry.status));
    expect([...listed].sort()).toEqual([...new Set(Object.values(EXIT))].sort());
    for (const { status, why } of EXIT_DESCRIPTIONS) {
      expect(help).toContain(String(status));
      expect(help).toContain(why);
    }
  });
});

describe("an internal error", () => {
  it("should return its own status, distinguishable from nothing to analyse", () => {
    const written: string[] = [];
    const status = statusFor(
      () => {
        throw new Error("something in the tool broke");
      },
      (message) => written.push(message),
    );
    expect(status).toBe(EXIT.internalError);
    expect(status).not.toBe(EXIT.nothingToAnalyse);
    expect(written.join("")).toContain("something in the tool broke");
  });

  it("should report a thrown non-error too", () => {
    const written: string[] = [];
    expect(
      statusFor(
        () => {
          throw "a bare string";
        },
        (message) => written.push(message),
      ),
    ).toBe(EXIT.internalError);
    expect(written.join("")).toContain("a bare string");
  });

  it("should pass a normal status through untouched", () => {
    expect(
      statusFor(
        () => EXIT.ok,
        () => {},
      ),
    ).toBe(EXIT.ok);
  });
});
