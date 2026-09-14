import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { JsxElementRecord } from "./jsx.js";
import {
  attributeLiteral,
  collectJsx,
  hasAttribute,
  isTestFile,
  readLintSuppressions,
  suppressesAt,
} from "./jsx.js";
import { scanSources } from "./sources.js";

/** Reads the first element, failing loudly instead of asserting non-null. */
function firstElement(file: { jsxElements: readonly JsxElementRecord[] }): JsxElementRecord {
  const [element] = file.jsxElements;
  if (!element) throw new Error("expected at least one jsx element");
  return element;
}

function scanOne(name: string, contents: string) {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-jsx-"));
  const full = join(root, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  const [file] = scanSources(root).files;
  if (!file) throw new Error("expected the file to be scanned");
  return file;
}

describe("element collection", () => {
  it("should record a self-closing element with its attribute names", () => {
    const file = scanOne("a.tsx", 'export const A = () => <img src="/a.png" alt="a" />\n');
    expect(file.jsxElements).toHaveLength(1);
    expect(file.jsxElements[0]?.tag).toBe("img");
    expect(hasAttribute(firstElement(file), "alt")).toBe(true);
  });

  it("should record a paired element the same way as a self-closing one", () => {
    const file = scanOne("a.tsx", 'export const A = () => <a href="/x">hi</a>\n');
    expect(file.jsxElements[0]?.tag).toBe("a");
    expect(attributeLiteral(firstElement(file), "href")).toBe("/x");
  });

  it("should record nothing for an element written inside a comment", () => {
    const file = scanOne(
      "a.tsx",
      'export const A = () => {\n  // <img src="/a.png" />\n  return null\n}\n',
    );
    expect(file.jsxElements).toEqual([]);
  });

  it("should record nothing for an element written inside a string", () => {
    const file = scanOne("a.ts", "export const markup = '<img src=\"/a.png\" />'\n");
    expect(file.jsxElements).toEqual([]);
  });

  it("should contribute no tag for a fragment", () => {
    const file = scanOne("a.tsx", "export const A = () => <><span /></>\n");
    expect(file.jsxElements.map((e) => e.tag)).toEqual(["span"]);
  });

  it("should record a dotted component name", () => {
    const file = scanOne("a.tsx", "export const A = () => <Form.Field />\n");
    expect(file.jsxElements[0]?.tag).toBe("Form.Field");
  });

  it("should record nested elements", () => {
    const file = scanOne("a.tsx", "export const A = () => <div><img /><a /></div>\n");
    expect(file.jsxElements.map((e) => e.tag).sort()).toEqual(["a", "div", "img"]);
  });

  it("should parse jsx in a plain js file", () => {
    const file = scanOne("a.js", 'export const A = () => <img src="/a.png" />\n');
    expect(file.jsxElements[0]?.tag).toBe("img");
  });
});

describe("attribute values", () => {
  it("should read a string literal value", () => {
    const file = scanOne("a.tsx", 'export const A = () => <script type="application/ld+json" />\n');
    expect(attributeLiteral(firstElement(file), "type")).toBe("application/ld+json");
  });

  it("should read a literal written inside braces", () => {
    const file = scanOne("a.tsx", 'export const A = () => <a href={"/x"} />\n');
    expect(attributeLiteral(firstElement(file), "href")).toBe("/x");
  });

  it("should mark an expression value as unresolved but keep the name", () => {
    const file = scanOne("a.tsx", "export const A = ({ u }) => <a href={u} />\n");
    const element = firstElement(file);
    expect(hasAttribute(element, "href")).toBe(true);
    expect(attributeLiteral(element, "href")).toBeUndefined();
  });

  it("should record a bare attribute as present with no literal", () => {
    const file = scanOne("a.tsx", "export const A = () => <Image fill />\n");
    const element = firstElement(file);
    expect(hasAttribute(element, "fill")).toBe(true);
    expect(attributeLiteral(element, "fill")).toBeUndefined();
  });

  it("should contribute nothing for a spread", () => {
    const file = scanOne("a.tsx", "export const A = (p) => <img {...p} />\n");
    expect(file.jsxElements[0]?.attributes.size).toBe(0);
  });
});

describe("test file marking", () => {
  it("should mark the usual test and spec suffixes", () => {
    expect(isTestFile("/p/a.test.ts")).toBe(true);
    expect(isTestFile("/p/a.spec.tsx")).toBe(true);
    expect(isTestFile("/p/__tests__/a.ts")).toBe(true);
    expect(isTestFile("/p/e2e/a.ts")).toBe(true);
  });

  /**
   * A suffix naming what the test exercises still names a test. Measured: langfuse names 389 of
   * them this way, and every one was being read as production code.
   */
  it("should mark a suffix that names what the test exercises", () => {
    expect(isTestFile("/p/src/__e2e__/api.servertest.ts")).toBe(true);
    expect(isTestFile("/p/src/components/MediaTag.clienttest.tsx")).toBe(true);
    expect(isTestFile("/p/src/a.browsertest.ts")).toBe(true);
  });

  it("should not mark a source file whose name merely ends in test", () => {
    expect(isTestFile("/p/lib/latest.ts")).toBe(false);
    expect(isTestFile("/p/lib/servertest.ts")).toBe(false);
  });

  it("should not mark ordinary source", () => {
    expect(isTestFile("/p/app/page.tsx")).toBe(false);
    expect(isTestFile("/p/app/latest.ts")).toBe(false);
  });

  it("should carry the mark onto the file record", () => {
    expect(scanOne("a.test.tsx", "export const A = () => <img />\n").isTest).toBe(true);
    expect(scanOne("a.tsx", "export const A = () => <img />\n").isTest).toBe(false);
  });
});

function parse(source: string) {
  return ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
}

const RULE = "@next/next/no-img-element";

describe("where an element sits", () => {
  it("should record the line the opening tag starts on, counting from one", () => {
    const elements = collectJsx(
      parse(["const a = 1;", "", "export const P = () => <img src='/a.png' />;"].join("\n")),
    );
    expect(elements.map((element) => [element.tag, element.line])).toEqual([["img", 3]]);
  });

  it("should record the opening tag's line for an element with children", () => {
    const elements = collectJsx(
      parse(["", "", "const x = <div>", "  <span />", "</div>;"].join("\n")),
    );
    expect(elements.find((element) => element.tag === "div")?.line).toBe(3);
    expect(elements.find((element) => element.tag === "span")?.line).toBe(4);
  });
});

describe("the lint rules a file turns off", () => {
  it("should read a file-wide disable naming the rule", () => {
    const found = readLintSuppressions(`/* eslint-disable ${RULE} */\nconst a = 1;\n`);
    expect(found.fileWide.has(RULE)).toBe(true);
    expect(suppressesAt(found, RULE, 99)).toBe(true);
  });

  it("should read a disable on the element's own line", () => {
    const found = readLintSuppressions(
      ["const a = 1;", `const b = <img />; // eslint-disable-line ${RULE}`].join("\n"),
    );
    expect(suppressesAt(found, RULE, 2)).toBe(true);
    expect(suppressesAt(found, RULE, 1)).toBe(false);
  });

  it("should read a disable on the line above", () => {
    const found = readLintSuppressions(
      [`// eslint-disable-next-line ${RULE}`, "const b = <img />;"].join("\n"),
    );
    expect(suppressesAt(found, RULE, 2)).toBe(true);
    expect(suppressesAt(found, RULE, 1)).toBe(false);
  });

  it("should not index a disable naming a different rule", () => {
    const found = readLintSuppressions("/* eslint-disable react/no-danger */\nconst a = 1;\n");
    expect(suppressesAt(found, RULE, 2)).toBe(false);
    expect(found.fileWide.has("react/no-danger")).toBe(true);
  });

  /**
   * A blanket disable is a decision the author may not have made about this rule at all, so it
   * credits nothing. Silencing a finding on it would read somebody's convenience as an argument.
   */
  it("should index a blanket disable under no rule", () => {
    const found = readLintSuppressions("/* eslint-disable */\nconst a = 1;\n");
    expect(found.fileWide.size).toBe(0);
    expect(suppressesAt(found, RULE, 2)).toBe(false);
  });

  it("should read several rules from one directive", () => {
    const found = readLintSuppressions(`/* eslint-disable react/no-danger, ${RULE} */\n`);
    expect(found.fileWide.has(RULE)).toBe(true);
    expect(found.fileWide.has("react/no-danger")).toBe(true);
  });

  /** ESLint honours a file-wide directive in the prologue; one written after code is not one. */
  it("should not read a file-wide disable written after the first statement", () => {
    const found = readLintSuppressions(`const a = 1;\n/* eslint-disable ${RULE} */\n`);
    expect(found.fileWide.has(RULE)).toBe(false);
  });

  it("should read a file-wide disable after a directive prologue and other comments", () => {
    const found = readLintSuppressions(
      ["'use client';", "// a note", `/* eslint-disable ${RULE} */`, "const a = 1;"].join("\n"),
    );
    expect(found.fileWide.has(RULE)).toBe(true);
  });
});
