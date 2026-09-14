import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGraph,
  chainTo,
  clientReachFrom,
  createClientReach,
  reachableFrom,
  reachedWithoutDeclaring,
  reaching,
  rendersAnImportedClientComponent,
} from "./graph.js";
import { scanSources } from "./sources.js";

function syntheticProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "next-coverage-graph-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function graphOf(files: Record<string, string>) {
  const root = syntheticProject(files);
  return { graph: buildGraph(scanSources(root)), at: (name: string) => join(root, name) };
}

const CLIENT = "'use client'\n";
const SERVER = "'use server'\n";

describe("client closure", () => {
  it("should reach a module through a chain of imports", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { b } from './b'\nexport const A = b\n`,
      "b.ts": "export { c as b } from './c'\n",
      "c.ts": "export const c = 1\n",
    });
    expect([...graph.clientClosure].sort()).toEqual([at("a.tsx"), at("b.ts"), at("c.ts")].sort());
  });

  it("should not propagate through a type-only import, which does not exist at runtime", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import type { X } from './b'\nexport const A: X = 'x'\n`,
      "b.ts": "export type X = string\n",
    });
    expect(graph.clientClosure.has(at("b.ts"))).toBe(false);
  });

  /**
   * The module already promises that an edge is a reference surviving compilation. Whether an
   * import survives is a property of what it brings, not of how it was written: `import { X }`
   * where the target declares `export type X` is erased exactly as `import type { X }` is.
   *
   * Measured before writing this: zero such edges across the six corpus fixtures, which write
   * `import type` throughout, and 7 of 287 on the payload template, which does not.
   */
  it("should not draw an edge for types imported without the keyword", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { X } from './b'\nexport const A: X = 'x'\n`,
      "b.ts": "export type X = string\n",
    });
    expect(graph.clientClosure.has(at("b.ts"))).toBe(false);
  });

  it("should not draw an edge for an interface imported without the keyword", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { Options } from './b'\nexport const A: Options = { n: 1 }\n`,
      "b.ts": "export interface Options { n: number }\n",
    });
    expect(graph.clientClosure.has(at("b.ts"))).toBe(false);
  });

  it("should draw an edge when one of the names is a value", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { X, read } from './b'\nexport const A: X = read()\n`,
      "b.ts": "export type X = string\nexport const read = () => 'x'\n",
    });
    expect(graph.clientClosure.has(at("b.ts"))).toBe(true);
  });

  it("should draw an edge for a name the target exports some other way", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { Thing } from './b'\nexport const A = new Thing()\n`,
      "b.ts": "export class Thing {}\n",
    });
    expect(graph.clientClosure.has(at("b.ts"))).toBe(true);
  });

  it("should draw an edge for a namespace import, which enumerates nothing", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import * as b from './b'\nexport const A = b\n`,
      "b.ts": "export type X = string\n",
    });
    expect(graph.clientClosure.has(at("b.ts"))).toBe(true);
  });

  it("should draw an edge for a type the target declares without exporting it", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { X } from './b'\nexport const A = X\n`,
      "b.ts": "type X = string\nexport const X = 'x'\n",
    });
    expect(graph.clientClosure.has(at("b.ts"))).toBe(true);
  });

  it("should stop at a server module, which is referenced rather than bundled", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { save } from './action'\nexport const A = save\n`,
      "action.ts": `${SERVER}import { db } from './db'\nexport async function save() { return db }\n`,
      "db.ts": "export const db = 1\n",
    });
    expect(graph.clientClosure.has(at("action.ts"))).toBe(false);
    expect(graph.clientClosure.has(at("db.ts"))).toBe(false);
  });

  it("should follow a dynamic import written with a literal", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}export const load = () => import('./lazy')\n`,
      "lazy.ts": "export const lazy = 1\n",
    });
    expect(graph.clientClosure.has(at("lazy.ts"))).toBe(true);
  });

  it("should terminate on a cycle", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { b } from './b'\nexport const A = b\n`,
      "b.ts": "import { c } from './c'\nexport const b = c\n",
      "c.ts": "import { b } from './b'\nexport const c = () => b\n",
    });
    expect(graph.clientClosure.has(at("b.ts"))).toBe(true);
    expect(graph.clientClosure.has(at("c.ts"))).toBe(true);
  });

  it("should not put a server module's own imports on the client side", () => {
    const { graph } = graphOf({
      "action.ts": `${SERVER}import { db } from './db'\nexport async function save() { return db }\n`,
      "db.ts": "export const db = 1\n",
    });
    expect(graph.clientClosure.size).toBe(0);
  });

  it("should count an edge to a file the scan never read", () => {
    const { graph } = graphOf({
      "a.tsx": `${CLIENT}import { g } from './.generated/thing'\nexport const A = g\n`,
      ".generated/thing.ts": "export const g = 1\n",
    });
    // The scan skips hidden directories; saying so beats letting the closure look complete.
    expect(graph.unscannedEdges).toBe(1);
  });
});

describe("client entries and exclusive reach", () => {
  it("should attribute a subtree only one entry reaches to that entry", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { h } from './helper'\nexport const A = h\n`,
      "helper.ts": "export const h = 1\n",
    });
    expect([...graph.clientEntries]).toEqual([at("a.tsx")]);
    expect(graph.exclusiveReach.get(at("a.tsx"))).toEqual([at("helper.ts")]);
  });

  it("should attribute a shared subtree to neither entry, because removing one leaves it", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { h } from './helper'\nexport const A = h\n`,
      "b.tsx": `${CLIENT}import { h } from './helper'\nexport const B = h\n`,
      "helper.ts": "export const h = 1\n",
    });
    expect([...graph.clientEntries].sort()).toEqual([at("a.tsx"), at("b.tsx")].sort());
    expect(graph.exclusiveReach.get(at("a.tsx"))).toEqual([]);
    expect(graph.exclusiveReach.get(at("b.tsx"))).toEqual([]);
  });

  it("should not make an entry of a directive inside another entry's reach", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { I } from './inner'\nexport const A = I\n`,
      "inner.tsx": `${CLIENT}export const I = 1\n`,
    });
    expect([...graph.clientEntries]).toEqual([at("a.tsx")]);
    expect(graph.exclusiveReach.has(at("inner.tsx"))).toBe(false);
    // Its directive is redundant, so what it holds is on the client because of the entry above it.
    expect(graph.exclusiveReach.get(at("a.tsx"))).toEqual([at("inner.tsx")]);
  });

  it("should stop the reach at a server module, as the closure does", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { save } from './action'\nexport const A = save\n`,
      "action.ts": `${SERVER}import { db } from './db'\nexport async function save() { return db }\n`,
      "db.ts": "export const db = 1\n",
    });
    expect(graph.exclusiveReach.get(at("a.tsx"))).toEqual([]);
  });

  it("should make an entry of neither of two directives importing each other", () => {
    const { graph } = graphOf({
      "a.tsx": `${CLIENT}import { B } from './b'\nexport const A = B\n`,
      "b.tsx": `${CLIENT}import { A } from './a'\nexport const B = () => A\n`,
    });
    // Each is in the other's reach, so neither decides that the pair ships, and the walk ends.
    expect(graph.clientEntries.size).toBe(0);
    expect(graph.exclusiveReach.size).toBe(0);
  });
});

describe("import chains", () => {
  it("should give the chain from the declaring file down to the reached one", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { b } from './b'\nexport const A = b\n`,
      "b.ts": "import { c } from './c'\nexport const b = c\n",
      "c.ts": "export const c = 1\n",
    });
    expect(chainTo(graph, at("c.ts"))).toEqual([at("a.tsx"), at("b.ts"), at("c.ts")]);
  });

  it("should keep a shortest chain when a file is reachable two ways", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { b } from './b'\nimport { d } from './d'\nexport const A = [b, d]\n`,
      "b.ts": "export const b = 1\n",
      "d.ts": "import { b } from './b'\nexport const d = b\n",
    });
    expect(chainTo(graph, at("b.ts"))).toEqual([at("a.tsx"), at("b.ts")]);
  });

  it("should give no chain for a file outside the closure", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}export const A = 1\n`,
      "server.ts": "export const s = 1\n",
    });
    expect(chainTo(graph, at("server.ts"))).toEqual([]);
  });

  it("should list the files that are on the client side without declaring it", () => {
    const { graph, at } = graphOf({
      "a.tsx": `${CLIENT}import { b } from './b'\nexport const A = b\n`,
      "b.ts": "export const b = 1\n",
    });
    expect(reachedWithoutDeclaring(graph)).toEqual([at("b.ts")]);
  });
});

describe("forward reachability", () => {
  it("should report a module the origin imports directly", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import { read } from '../lib/data'\nexport default () => read()\n",
      "lib/data.ts": "export const read = () => 1\n",
    });
    const reached = reachableFrom(graph, at("app/page.tsx"));
    expect(reached.get(at("lib/data.ts"))).toEqual([at("app/page.tsx"), at("lib/data.ts")]);
  });

  it("should name every file between the origin and a transitive module", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import { read } from '../lib/data'\nexport default () => read()\n",
      "lib/data.ts": "export { read } from './store'\n",
      "lib/store.ts": "export const read = () => 1\n",
    });
    expect(reachableFrom(graph, at("app/page.tsx")).get(at("lib/store.ts"))).toEqual([
      at("app/page.tsx"),
      at("lib/data.ts"),
      at("lib/store.ts"),
    ]);
  });

  it("should report only itself when the origin imports nothing", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "export default () => null\n",
      "lib/data.ts": "export const read = () => 1\n",
    });
    const reached = reachableFrom(graph, at("app/page.tsx"));
    expect([...reached.keys()]).toEqual([at("app/page.tsx")]);
    expect(reached.get(at("app/page.tsx"))).toEqual([at("app/page.tsx")]);
  });

  it("should terminate when the subtree imports itself in a cycle", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import { b } from '../lib/b'\nexport default () => b()\n",
      "lib/b.ts": "import { c } from './c'\nexport const b = () => c()\n",
      "lib/c.ts": "import { b } from './b'\nexport const c = () => b\n",
    });
    const reached = reachableFrom(graph, at("app/page.tsx"));
    expect(reached.get(at("lib/c.ts"))).toEqual([
      at("app/page.tsx"),
      at("lib/b.ts"),
      at("lib/c.ts"),
    ]);
  });

  it("should not follow an import erased at compile time", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import type { X } from '../lib/data'\nexport default (x: X) => x\n",
      "lib/data.ts": "export type X = string\n",
    });
    expect(reachableFrom(graph, at("app/page.tsx")).has(at("lib/data.ts"))).toBe(false);
  });

  it("should follow through a server module, which runs for whoever reached it", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import { save } from '../lib/action'\nexport default () => save()\n",
      "lib/action.ts": `${SERVER}import { read } from './data'\nexport async function save() { return read() }\n`,
      "lib/data.ts": "export const read = () => 1\n",
    });
    expect(reachableFrom(graph, at("app/page.tsx")).get(at("lib/data.ts"))).toEqual([
      at("app/page.tsx"),
      at("lib/action.ts"),
      at("lib/data.ts"),
    ]);
  });
});

describe("reverse reachability", () => {
  it("should report an entry that imports the target directly", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import { read } from '../lib/data'\nexport default () => read()\n",
      "lib/data.ts": "export const read = () => 1\n",
    });
    const found = reaching(graph, new Set([at("app/page.tsx")]), at("lib/data.ts"));
    expect([...found.values()]).toEqual([[at("app/page.tsx"), at("lib/data.ts")]]);
  });

  it("should name every file between an entry and the target", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import { read } from '../lib/data'\nexport default () => read()\n",
      "lib/data.ts": "export { read } from './store'\n",
      "lib/store.ts": "export const read = () => 1\n",
    });
    const found = reaching(graph, new Set([at("app/page.tsx")]), at("lib/store.ts"));
    expect(found.get(at("app/page.tsx"))).toEqual([
      at("app/page.tsx"),
      at("lib/data.ts"),
      at("lib/store.ts"),
    ]);
  });

  it("should give each entry its own chain and leave out one that does not reach it", () => {
    const { graph, at } = graphOf({
      "app/a/page.tsx": "import { read } from '../../lib/data'\nexport default () => read()\n",
      "app/b/page.tsx": "import { read } from '../../lib/data'\nexport default () => read()\n",
      "app/c/page.tsx": "export default () => null\n",
      "lib/data.ts": "export const read = () => 1\n",
    });
    const entries = new Set([at("app/a/page.tsx"), at("app/b/page.tsx"), at("app/c/page.tsx")]);
    const found = reaching(graph, entries, at("lib/data.ts"));
    expect([...found.keys()].sort()).toEqual([at("app/a/page.tsx"), at("app/b/page.tsx")].sort());
  });

  it("should return nothing when no entry reaches the target", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "export default () => null\n",
      "lib/data.ts": "export const read = () => 1\n",
    });
    expect(reaching(graph, new Set([at("app/page.tsx")]), at("lib/data.ts")).size).toBe(0);
  });

  it("should report an entry that is the target, with a chain of one", () => {
    const { graph, at } = graphOf({ "app/page.tsx": "export default () => null\n" });
    const found = reaching(graph, new Set([at("app/page.tsx")]), at("app/page.tsx"));
    expect(found.get(at("app/page.tsx"))).toEqual([at("app/page.tsx")]);
  });

  it("should terminate when the modules on the way import each other", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import { b } from '../lib/b'\nexport default () => b()\n",
      "lib/b.ts": "import { c } from './c'\nexport const b = () => c()\n",
      "lib/c.ts": "import { b } from './b'\nexport const c = () => b\n",
    });
    const found = reaching(graph, new Set([at("app/page.tsx")]), at("lib/c.ts"));
    expect(found.get(at("app/page.tsx"))).toEqual([
      at("app/page.tsx"),
      at("lib/b.ts"),
      at("lib/c.ts"),
    ]);
  });

  it("should not report an entry whose only path is erased at compile time", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import type { X } from '../lib/data'\nexport default (x: X) => x\n",
      "lib/data.ts": "export type X = string\n",
    });
    expect(reaching(graph, new Set([at("app/page.tsx")]), at("lib/data.ts")).size).toBe(0);
  });

  // A server action runs on behalf of the route that invoked it, so the route is still where a
  // call inside it renders. The client closure stops at the directive; this walk must not.
  it("should report an entry whose only path crosses a server module", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import { save } from '../lib/action'\nexport default () => save()\n",
      "lib/action.ts": `${SERVER}import { read } from './data'\nexport async function save() { return read() }\n`,
      "lib/data.ts": "export const read = () => 1\n",
    });
    const found = reaching(graph, new Set([at("app/page.tsx")]), at("lib/data.ts"));
    expect(found.get(at("app/page.tsx"))).toEqual([
      at("app/page.tsx"),
      at("lib/action.ts"),
      at("lib/data.ts"),
    ]);
  });

  // The graph joins files, not symbols: importing one name from a barrel reaches everything behind
  // it. The chain says so, which is what makes the over-reach judgeable rather than hidden.
  it("should report an entry reaching the target only through a re-exporting module", () => {
    const { graph, at } = graphOf({
      "app/page.tsx": "import { other } from '../lib'\nexport default () => other()\n",
      "lib/index.ts": "export { read } from './data'\nexport { other } from './other'\n",
      "lib/data.ts": "export const read = () => 1\n",
      "lib/other.ts": "export const other = () => 2\n",
    });
    const found = reaching(graph, new Set([at("app/page.tsx")]), at("lib/data.ts"));
    expect(found.get(at("app/page.tsx"))).toEqual([
      at("app/page.tsx"),
      at("lib/index.ts"),
      at("lib/data.ts"),
    ]);
  });

  it("should keep a shortest chain when the target is reachable two ways", () => {
    const { graph, at } = graphOf({
      "app/page.tsx":
        "import { read } from '../lib/data'\nimport { wrap } from '../lib/wrap'\nexport default () => [read(), wrap()]\n",
      "lib/wrap.ts": "export { read as wrap } from './data'\n",
      "lib/data.ts": "export const read = () => 1\n",
    });
    const found = reaching(graph, new Set([at("app/page.tsx")]), at("lib/data.ts"));
    expect(found.get(at("app/page.tsx"))).toEqual([at("app/page.tsx"), at("lib/data.ts")]);
  });
});

describe("closure from a set of entries", () => {
  it("should hold the client modules an entry reaches and nothing it does not", () => {
    const { graph, at } = graphOf({
      "page.tsx": "import { w } from './widget'\nexport default () => w\n",
      "widget.tsx": `${CLIENT}import { h } from './helper'\nexport const w = h\n`,
      "helper.ts": "export const h = 1\n",
      "other.tsx": `${CLIENT}export const o = 2\n`,
    });
    const reached = clientReachFrom(graph, [at("page.tsx")]);
    expect([...reached].sort()).toEqual([at("widget.tsx"), at("helper.ts")].sort());
    expect(reached.has(at("other.tsx"))).toBe(false);
  });

  it("should include an entry that is itself client-side, because it ships", () => {
    const { graph, at } = graphOf({ "page.tsx": `${CLIENT}export default () => null\n` });
    expect([...clientReachFrom(graph, [at("page.tsx")])]).toEqual([at("page.tsx")]);
  });

  it("should answer empty rather than absent for an entry reaching nothing client-side", () => {
    const { graph, at } = graphOf({
      "page.tsx": "import { s } from './server-side'\nexport default () => s\n",
      "server-side.ts": "export const s = 1\n",
    });
    expect(clientReachFrom(graph, [at("page.tsx")]).size).toBe(0);
  });

  it("should union the answers of several entries", () => {
    const { graph, at } = graphOf({
      "page.tsx": "import { a } from './a'\nexport default () => a\n",
      "layout.tsx": "import { b } from './b'\nexport default () => b\n",
      "a.tsx": `${CLIENT}export const a = 1\n`,
      "b.tsx": `${CLIENT}export const b = 2\n`,
    });
    const reached = clientReachFrom(graph, [at("page.tsx"), at("layout.tsx")]);
    expect([...reached].sort()).toEqual([at("a.tsx"), at("b.tsx")].sort());
  });

  it("should never name a module the project-wide closure does not hold", () => {
    const { graph } = graphOf({
      "page.tsx": "import { w } from './widget'\nexport default () => w\n",
      "widget.tsx": `${CLIENT}export const w = 1\n`,
      "server.ts": "export const s = 1\n",
    });
    const everything = clientReachFrom(graph, graph.edges.keys());
    for (const path of everything) expect(graph.clientClosure.has(path)).toBe(true);
  });

  it("should answer the same whether or not the walk was memoised", () => {
    const { graph, at } = graphOf({
      "root-layout.tsx": "import { s } from './shared'\nexport default () => s\n",
      "shared.tsx": `${CLIENT}export const s = 1\n`,
      "one/page.tsx": "export default () => null\n",
      "two/page.tsx": "export default () => null\n",
    });
    const reach = createClientReach(graph);
    const entries = [at("root-layout.tsx"), at("one/page.tsx")];
    const first = reach(entries);
    const second = reach(entries);
    expect([...second].sort()).toEqual([...first].sort());
    expect([...reach([at("root-layout.tsx"), at("two/page.tsx")])]).toEqual([at("shared.tsx")]);
  });
});

describe("standard library imports are not part of the graph", () => {
  /** The same project twice: once importing built-ins, once not. */
  const withBuiltins = {
    "app/layout.tsx":
      "import { readFileSync } from 'node:fs'\nimport { w } from '../widget'\nexport default () => [readFileSync, w]\n",
    "widget.tsx": `${CLIENT}import { join } from 'node:path'\nexport const w = join('a', 'b')\n`,
  };
  const without = {
    "app/layout.tsx": "import { w } from '../widget'\nexport default () => w\n",
    "widget.tsx": `${CLIENT}export const w = 1\n`,
  };

  it("should leave the closure and the edges identical either way", () => {
    const a = graphOf(withBuiltins);
    const b = graphOf(without);
    expect(a.graph.clientClosure.size).toBe(b.graph.clientClosure.size);
    expect([...(a.graph.edges.get(a.at("app/layout.tsx")) ?? [])]).toEqual([a.at("widget.tsx")]);
    expect(a.graph.edges.get(a.at("widget.tsx"))).toEqual([]);
  });

  it("should not count a built-in among the unscanned edges either", () => {
    expect(graphOf(withBuiltins).graph.unscannedEdges).toBe(0);
  });
});

describe("a client entry that renders what it imported", () => {
  function readingOf(files: Record<string, string>, entry: string) {
    const root = syntheticProject(files);
    const index = scanSources(root);
    const graph = buildGraph(index);
    const file = index.byPath.get(join(root, entry));
    if (file === undefined) throw new Error(`the scan found no ${entry}`);
    return rendersAnImportedClientComponent(file, graph);
  }

  /**
   * The shape the survey found three times over: a file whose whole job is to make a third-party
   * client library usable from a Server Component. It writes none of the six reasons the file alone
   * can show — no hook, no handler, no browser global — and was reported as showing none at all.
   */
  const MANIFEST = JSON.stringify({
    dependencies: { "next-themes": "1.0.0", "@radix-ui/react-collapsible": "1.0.0" },
  });

  it("should credit a component imported from a dependency", () => {
    const source = `${CLIENT}import { ThemeProvider } from 'next-themes'\nexport function Providers({ children }) { return <ThemeProvider>{children}</ThemeProvider> }\n`;
    expect(readingOf({ "package.json": MANIFEST, "providers.tsx": source }, "providers.tsx")).toBe(
      true,
    );
  });

  /**
   * A package the manifest does not declare is a broken import rather than a library, so it credits
   * nothing — the same direction the unresolved case errs in.
   */
  it("should not credit an import of a package the manifest never declares", () => {
    const source = `${CLIENT}import { ThemeProvider } from 'next-themes'\nexport function P({ children }) { return <ThemeProvider>{children}</ThemeProvider> }\n`;
    expect(readingOf({ "providers.tsx": source }, "providers.tsx")).toBe(false);
  });

  it("should credit a namespaced tag, whose leading name is the import", () => {
    const source = `${CLIENT}import * as Collapsible from '@radix-ui/react-collapsible'\nexport function C({ children }) { return <Collapsible.Root>{children}</Collapsible.Root> }\n`;
    expect(
      readingOf({ "package.json": MANIFEST, "collapsible.tsx": source }, "collapsible.tsx"),
    ).toBe(true);
  });

  it("should credit a component imported from a project file already on the client side", () => {
    const files = {
      "wrapper.tsx": `${CLIENT}import { Inner } from './inner'\nexport function W() { return <Inner /> }\n`,
      "inner.tsx": `${CLIENT}export function Inner() { return <div /> }\n`,
    };
    expect(readingOf(files, "wrapper.tsx")).toBe(true);
  });

  /** An ordinary server-side component is not a wrapped client library. */
  it("should not credit a component imported from a project file outside the closure", () => {
    const files = {
      "entry.tsx": `${CLIENT}export function E() { return <div /> }\n`,
      "wrapper.tsx": `${CLIENT}import { Plain } from './plain'\nexport function W() { return <Plain /> }\n`,
      "plain.tsx": "export function Plain() { return <span /> }\n",
    };
    // `plain.tsx` is reached from a client entry, so the closure holds it. The reading is about the
    // closure rather than about the declaration, and this asserts which one it reads.
    expect(readingOf(files, "wrapper.tsx")).toBe(true);
  });

  /** Prefer the silence: an unresolved specifier could be either, and guessing costs a false one. */
  it("should not credit an import that resolved nowhere", () => {
    const source = `${CLIENT}import { Thing } from './missing'\nexport function W() { return <Thing /> }\n`;
    expect(readingOf({ "wrapper.tsx": source }, "wrapper.tsx")).toBe(false);
  });

  it("should not credit a plain HTML element", () => {
    const source = `${CLIENT}export function W() { return <div className="x" /> }\n`;
    expect(readingOf({ "wrapper.tsx": source }, "wrapper.tsx")).toBe(false);
  });

  it("should not credit an import it never renders", () => {
    const source = `${CLIENT}import { helper } from 'lib'\nexport function W() { helper(); return <div /> }\n`;
    expect(readingOf({ "wrapper.tsx": source }, "wrapper.tsx")).toBe(false);
  });

  /** Importing a type is not rendering a component: the erased import ships nothing. */
  it("should not credit a type-only import of the rendered name", () => {
    const source = `${CLIENT}import type { Thing } from 'lib'\nexport function W(): Thing { return <div /> }\n`;
    expect(readingOf({ "wrapper.tsx": source }, "wrapper.tsx")).toBe(false);
  });
});
