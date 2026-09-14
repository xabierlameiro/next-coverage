import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClientDirectiveReasons } from "./client-reasons.js";
import { showsNoReason } from "./client-reasons.js";
import { scanSources } from "./sources.js";

const CLIENT = "'use client'\n";

function syntheticProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-reasons-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

/** The summary of one file, scanned as the pipeline scans it. */
function reasonsOf(contents: string, name = "a.tsx"): ClientDirectiveReasons {
  const root = syntheticProject({ [name]: contents });
  const file = scanSources(root).byPath.get(join(root, name));
  if (!file?.clientReasons) throw new Error("expected a summary on a file declaring the directive");
  return file.clientReasons;
}

describe("the client directive summary", () => {
  it("should be absent on a file that does not declare the directive", () => {
    const root = syntheticProject({ "a.tsx": "export const A = 1\n" });
    expect(scanSources(root).byPath.get(join(root, "a.tsx"))?.clientReasons).toBeUndefined();
  });

  it("should read a hook call, and read none where the file calls no hook", () => {
    expect(
      reasonsOf(`${CLIENT}import { useState } from 'react'\nexport const A = () => useState(0)\n`)
        .hookCall,
    ).toBe(true);
    expect(reasonsOf(`${CLIENT}export const A = () => null\n`).hookCall).toBe(false);
  });

  it("should read a hook called off the React namespace", () => {
    expect(
      reasonsOf(`${CLIENT}import React from 'react'\nexport const A = () => React.useMemo(f)\n`)
        .hookCall,
    ).toBe(true);
  });

  it("should read a handler attribute, and read none where no attribute is one", () => {
    expect(
      reasonsOf(`${CLIENT}export const A = () => <button onClick={f}>x</button>\n`)
        .handlerAttribute,
    ).toBe(true);
    expect(
      reasonsOf(`${CLIENT}export const A = () => <button type="submit">x</button>\n`)
        .handlerAttribute,
    ).toBe(false);
  });

  it("should read a browser global, and read none where the file names no global", () => {
    expect(reasonsOf(`${CLIENT}export const A = () => document.title\n`).browserGlobal).toBe(true);
    expect(reasonsOf(`${CLIENT}export const A = () => 'title'\n`).browserGlobal).toBe(false);
  });

  it("should not read a browser global from a property of that name", () => {
    expect(
      reasonsOf(`${CLIENT}export const A = (theme) => theme.location + theme.window\n`)
        .browserGlobal,
    ).toBe(false);
  });

  it("should read a client-only import, and read none from another package", () => {
    expect(reasonsOf(`${CLIENT}import 'client-only'\nexport const A = 1\n`).clientOnlyImport).toBe(
      true,
    );
    expect(reasonsOf(`${CLIENT}import 'server-only'\nexport const A = 1\n`).clientOnlyImport).toBe(
      false,
    );
  });

  it("should read a class component, and read none from another class", () => {
    expect(
      reasonsOf(`${CLIENT}import { Component } from 'react'\nexport class A extends Component {}\n`)
        .classComponent,
    ).toBe(true);
    expect(reasonsOf(`${CLIENT}export class A extends Error {}\n`).classComponent).toBe(false);
  });

  it("should read a createContext call, and read none where the file makes no context", () => {
    expect(
      reasonsOf(
        `${CLIENT}import { createContext } from 'react'\nexport const C = createContext(null)\n`,
      ).createsContext,
    ).toBe(true);
    expect(reasonsOf(`${CLIENT}export const C = null\n`).createsContext).toBe(false);
  });

  it("should read nothing from a use in an import specifier, a handler in a string or a global in a comment", () => {
    const reasons = reasonsOf(
      [
        CLIENT,
        "import { useState } from 'react'\n",
        "// window.matchMedia would be a reason, and a comment naming it is not one\n",
        "export const A = () => <p title=\"onClick\">{'onClick'}</p>\n",
      ].join(""),
    );
    expect(reasons).toEqual({
      hookCall: false,
      handlerAttribute: false,
      browserGlobal: false,
      clientOnlyImport: false,
      classComponent: false,
      createsContext: false,
    });
    expect(showsNoReason(reasons)).toBe(true);
  });
});
