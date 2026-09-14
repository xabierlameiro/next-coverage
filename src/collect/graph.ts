import type { SourceFileRecord, SourceIndex } from "./sources.js";

const CLIENT_DIRECTIVE = "use client";
const SERVER_DIRECTIVE = "use server";

export type ModuleGraph = {
  /** File to file, over references that still exist at runtime. */
  readonly edges: ReadonlyMap<string, readonly string[]>;
  /** Files declaring the client directive in their prologue. */
  readonly clientDeclared: ReadonlySet<string>;
  /** Files declaring the server directive in their prologue: an RPC boundary, not a bundled one. */
  readonly serverDeclared: ReadonlySet<string>;
  /** The declared client files plus everything reachable from them. */
  readonly clientClosure: ReadonlySet<string>;
  /** For each file in the closure, the file that first reached it. */
  readonly reachedFrom: ReadonlyMap<string, string>;
  /**
   * The declaring files no other declaring file reaches. A directive inside another one's reach is
   * redundant to the closure: removing it changes nothing about what is on the client side.
   */
  readonly clientEntries: ReadonlySet<string>;
  /**
   * For each client entry, the closure files no other entry reaches — what is on the client because
   * of that one directive. The entry itself is not among them, so a leaf entry reaches nothing.
   */
  readonly exclusiveReach: ReadonlyMap<string, readonly string[]>;
  /** Internal edges pointing at a file the scan never read. Disclosed rather than dropped. */
  readonly unscannedEdges: number;
};

/**
 * Whether an import brings nothing but names the target declares as a type.
 *
 * The keyword is not what decides erasure: `import { X }` where the target writes `export type X`
 * is erased exactly as `import type { X }` is, and an edge for it is a path the program cannot
 * take. Read from the target's own type declarations, so a name it exports some other way — a
 * class, an enum, a form the scan does not record — keeps its edge. Failing to find a value is not
 * finding a type, and a lost edge silently shrinks the client closure.
 *
 * An import naming no bindings enumerates nothing to check: a namespace or side-effect import
 * keeps its edge.
 */
function bringsOnlyTypes(
  file: SourceFileRecord,
  specifier: string,
  target: SourceFileRecord,
): boolean {
  const bindings = file.imports.get(specifier) ?? [];
  if (bindings.length === 0 || target.exportedTypeNames.length === 0) return false;
  const types = new Set(target.exportedTypeNames);
  return bindings.every((binding) => types.has(binding.imported));
}

/**
 * A directive counts only in the file prologue. One inside a function body scopes to that
 * function, and says nothing about how the module itself is bundled.
 */
function declares(file: SourceFileRecord, directive: string): boolean {
  return file.fileDirectives.includes(directive);
}

/**
 * The graph joins files over the references that survive compilation: a type-only import is erased,
 * so it is not an edge. A dynamic import with a literal specifier is one, because the module it
 * names still ships, in a chunk of its own.
 */
export function buildGraph(index: SourceIndex): ModuleGraph {
  const edges = new Map<string, readonly string[]>();
  const clientDeclared = new Set<string>();
  const serverDeclared = new Set<string>();
  let unscannedEdges = 0;

  for (const file of index.files) {
    if (declares(file, CLIENT_DIRECTIVE)) clientDeclared.add(file.path);
    if (declares(file, SERVER_DIRECTIVE)) serverDeclared.add(file.path);

    const targets: string[] = [];
    for (const reference of file.moduleReferences) {
      if (reference.typeOnly || reference.resolution.kind !== "internal") continue;
      const target = reference.resolution.path;
      const scanned = index.byPath.get(target);
      if (scanned === undefined) {
        unscannedEdges += 1;
        continue;
      }
      if (bringsOnlyTypes(file, reference.specifier, scanned)) continue;
      if (!targets.includes(target)) targets.push(target);
    }
    edges.set(file.path, targets);
  }

  const { closure, reachedFrom } = closeOverClient(edges, clientDeclared, serverDeclared);
  const clientEntries = entriesAmong(edges, clientDeclared, serverDeclared);
  return {
    edges,
    clientDeclared,
    serverDeclared,
    clientClosure: closure,
    reachedFrom,
    clientEntries,
    exclusiveReach: exclusiveReachOf(edges, clientEntries, serverDeclared),
    unscannedEdges,
  };
}

/**
 * Breadth-first, so the chain kept for a file is a shortest one: the fewest imports a reader has to
 * follow to see why that file is on the client side.
 */
function closeOverClient(
  edges: ReadonlyMap<string, readonly string[]>,
  clientDeclared: ReadonlySet<string>,
  serverDeclared: ReadonlySet<string>,
): { closure: Set<string>; reachedFrom: Map<string, string> } {
  const closure = new Set(clientDeclared);
  const reachedFrom = new Map<string, string>();
  const queue = [...clientDeclared];

  for (let head = 0; head < queue.length; head += 1) {
    const from = queue[head];
    if (from === undefined) continue;
    for (const target of edges.get(from) ?? []) {
      // A server module is reached by reference, not by bundling, so the closure stops here.
      if (serverDeclared.has(target) || closure.has(target)) continue;
      closure.add(target);
      reachedFrom.set(target, from);
      queue.push(target);
    }
  }
  return { closure, reachedFrom };
}

/**
 * What `origin` reaches over value edges, stopping where the closure stops: a server module is
 * referenced rather than bundled, so nothing behind it is on the client because of `origin`. The
 * origin is in the result only when a cycle leads back to it, and callers drop it themselves.
 */
function reachOverValues(
  edges: ReadonlyMap<string, readonly string[]>,
  serverDeclared: ReadonlySet<string>,
  origin: string,
): Set<string> {
  const reached = new Set<string>();
  const queue = [origin];

  for (let head = 0; head < queue.length; head += 1) {
    const from = queue[head];
    if (from === undefined) continue;
    for (const to of edges.get(from) ?? []) {
      if (serverDeclared.has(to) || reached.has(to)) continue;
      reached.add(to);
      queue.push(to);
    }
  }
  return reached;
}

/**
 * Which declaring files decide that a subtree ships. A file another declaring file already reaches
 * decides nothing: it is in the closure either way, so its directive is redundant and nothing is
 * attributed to it. Two declaring files importing each other therefore leave neither an entry.
 */
function entriesAmong(
  edges: ReadonlyMap<string, readonly string[]>,
  clientDeclared: ReadonlySet<string>,
  serverDeclared: ReadonlySet<string>,
): Set<string> {
  const reachedByAnother = new Set<string>();
  for (const declaring of clientDeclared) {
    for (const path of reachOverValues(edges, serverDeclared, declaring)) {
      // Reached from itself through a cycle says nothing; the other file's own walk says it.
      if (path !== declaring) reachedByAnother.add(path);
    }
  }
  return new Set([...clientDeclared].filter((path) => !reachedByAnother.has(path)));
}

/**
 * For each entry, the files it alone reaches. A file two entries reach is in neither's: removing
 * one entry leaves it on the client, so attributing it to either would overstate what that one
 * directive carries. Everything reached from an entry is already in the closure by construction.
 */
function exclusiveReachOf(
  edges: ReadonlyMap<string, readonly string[]>,
  clientEntries: ReadonlySet<string>,
  serverDeclared: ReadonlySet<string>,
): Map<string, readonly string[]> {
  // One owner per file, and null once a second entry claims it: a count of entries is never needed.
  const owner = new Map<string, string | null>();
  for (const entry of clientEntries) {
    for (const path of reachOverValues(edges, serverDeclared, entry)) {
      if (path === entry) continue;
      if (!owner.has(path)) owner.set(path, entry);
      else if (owner.get(path) !== entry) owner.set(path, null);
    }
  }

  const exclusive = new Map<string, string[]>();
  for (const entry of clientEntries) exclusive.set(entry, []);
  for (const [path, holder] of owner) {
    if (holder !== null) exclusive.get(holder)?.push(path);
  }
  for (const paths of exclusive.values()) paths.sort();
  return exclusive;
}

/**
 * The import chain that puts a file on the client side, from the file that declares the directive
 * down to the file itself. Empty when the file is not in the closure.
 */
export function chainTo(graph: ModuleGraph, path: string): readonly string[] {
  if (!graph.clientClosure.has(path)) return [];
  const chain = [path];
  let current = graph.reachedFrom.get(path);
  while (current !== undefined) {
    chain.unshift(current);
    current = graph.reachedFrom.get(current);
  }
  return chain;
}

/** Files inside the client closure that declare nothing themselves. */
export function reachedWithoutDeclaring(graph: ModuleGraph): string[] {
  return [...graph.clientClosure].filter((path) => !graph.clientDeclared.has(path));
}

/**
 * Which of `entries` reach `target` over value edges, and the import chain that gets each one
 * there. Breadth-first backwards from the target, so a chain is a shortest one: the fewest imports
 * a reader has to follow to see why that entry reaches the file.
 *
 * The walk does not stop at a server module. The client closure stops there because such a module
 * is referenced rather than bundled; reachability asks a different question, and a module invoked
 * over that boundary still runs on behalf of whoever reached it.
 *
 * The reverse adjacency is built here rather than kept on the graph: one consumer wants it, and
 * widening a type four other modules read costs more than the walk does.
 */
export function reaching(
  graph: ModuleGraph,
  entries: ReadonlySet<string>,
  target: string,
): Map<string, readonly string[]> {
  const importers = new Map<string, string[]>();
  for (const [from, targets] of graph.edges) {
    for (const to of targets) {
      const known = importers.get(to);
      if (known === undefined) importers.set(to, [from]);
      else known.push(from);
    }
  }

  // Parent pointers run towards the target, so reversing one gives the chain a reader wants.
  const towardsTarget = new Map<string, string>();
  const seen = new Set([target]);
  const queue = [target];
  const found = new Map<string, readonly string[]>();
  if (entries.has(target)) found.set(target, [target]);

  for (let head = 0; head < queue.length; head += 1) {
    const to = queue[head];
    if (to === undefined) continue;
    for (const from of importers.get(to) ?? []) {
      if (seen.has(from)) continue;
      seen.add(from);
      towardsTarget.set(from, to);
      queue.push(from);
      if (entries.has(from)) found.set(from, chainFrom(towardsTarget, from, target));
    }
  }
  return found;
}

/**
 * What `origin` reaches over value edges, and a shortest import chain to each, origin first. The
 * mirror of `reaching`: that one asks which entries reach a file, this one asks what one file's
 * subtree reaches. The graph's edges already point this way, so no reverse index is needed.
 *
 * Like `reaching` and unlike the client closure, it does not stop at a server module: such a module
 * still runs on behalf of whoever reached it.
 */
export function reachableFrom(graph: ModuleGraph, origin: string): Map<string, readonly string[]> {
  const cameFrom = new Map<string, string>();
  const reached = new Map<string, readonly string[]>([[origin, [origin]]]);
  const queue = [origin];

  for (let head = 0; head < queue.length; head += 1) {
    const from = queue[head];
    if (from === undefined) continue;
    for (const to of graph.edges.get(from) ?? []) {
      if (reached.has(to)) continue;
      cameFrom.set(to, from);
      queue.push(to);
      reached.set(to, chainBack(cameFrom, to, origin));
    }
  }
  return reached;
}

/**
 * Every file any of `entries` reaches over value edges, the entries included. `reachableFrom` for
 * many origins at once, without the chains: a selection asking only whether a file is reached
 * should not pay for one walk per origin.
 */
export function reachedFromAny(graph: ModuleGraph, entries: Iterable<string>): Set<string> {
  const reached = new Set(entries);
  const queue = [...reached];

  for (let head = 0; head < queue.length; head += 1) {
    const from = queue[head];
    if (from === undefined) continue;
    for (const to of graph.edges.get(from) ?? []) {
      if (reached.has(to)) continue;
      reached.add(to);
      queue.push(to);
    }
  }
  return reached;
}

/** Walks the parent pointers back to the origin, then reverses: the chain a reader follows. */
function chainBack(
  cameFrom: ReadonlyMap<string, string>,
  file: string,
  origin: string,
): readonly string[] {
  const chain = [file];
  let current = cameFrom.get(file);
  while (current !== undefined && chain.at(-1) !== origin) {
    chain.push(current);
    current = cameFrom.get(current);
  }
  return chain.reverse();
}

function chainFrom(
  towardsTarget: ReadonlyMap<string, string>,
  entry: string,
  target: string,
): readonly string[] {
  const chain = [entry];
  let current = towardsTarget.get(entry);
  while (current !== undefined && chain.at(-1) !== target) {
    chain.push(current);
    current = towardsTarget.get(current);
  }
  return chain;
}

/**
 * The client-side modules a set of entry files reaches. The project-wide closure answers how much
 * of the project reaches a browser; this answers which part of it a particular starting point
 * reaches — a route's own client surface rather than the project's.
 *
 * It is the intersection of the forward reach with the closure, never a second walk of its own:
 * two walks carrying the same stopping rules would be two chances to disagree about where the
 * boundary is, and the closure stays the single definition of client-side.
 */
export function clientReachFrom(graph: ModuleGraph, entries: Iterable<string>): Set<string> {
  return createClientReach(graph)(entries);
}

/**
 * The same answer, memoised per entry file. Sibling routes share every ancestor layout, and the
 * root layout is shared by all of them, so without this the same subtree is walked once per route.
 */
export function createClientReach(graph: ModuleGraph): (entries: Iterable<string>) => Set<string> {
  const cache = new Map<string, ReadonlySet<string>>();

  const reachOf = (entry: string): ReadonlySet<string> => {
    const hit = cache.get(entry);
    if (hit !== undefined) return hit;

    // Chains are what `reachableFrom` spends its time on, and a count of modules needs none.
    const reached = new Set<string>();
    const seen = new Set([entry]);
    const queue = [entry];
    for (let head = 0; head < queue.length; head += 1) {
      const from = queue[head];
      if (from === undefined) continue;
      if (graph.clientClosure.has(from)) reached.add(from);
      for (const to of graph.edges.get(from) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    cache.set(entry, reached);
    return reached;
  };

  return (entries) => {
    const union = new Set<string>();
    for (const entry of entries) {
      for (const path of reachOf(entry)) union.add(path);
    }
    return union;
  };
}

/**
 * Whether the file's own JSX renders a component it imported from client code somewhere else.
 *
 * This is the seventh reason for the client directive, and the one the other six cannot see. They
 * are facts about the file alone — a hook call, a handler attribute, a browser global, a
 * `client-only` import, a class component, a context creation — and a file whose whole job is to
 * make a third-party client library usable from a Server Component writes none of them. It imports
 * a component and renders it, and the directive is what lets a server component reach it. That is
 * the canonical shape of a shadcn/ui project: `theme-provider.tsx` wrapping next-themes,
 * `aspect-ratio.tsx` and `collapsible.tsx` wrapping Radix, and each one was reported as showing no
 * documented reason at all.
 *
 * It belongs here rather than beside the other six because it cannot be answered from one file: the
 * question is what is on the other side of the import, which is the graph's own subject.
 *
 * Three resolutions count, and they are the ones that name code this project did not write. An
 * external specifier is an installed dependency, and this reading does not open one — a package's
 * own directives are outside what the scan reads, so what it credits is that the file exists to
 * render something from somewhere else. A package the manifest declares and the machine has not
 * installed is the same fact: it resolves as missing only because nobody ran an install, and it
 * would be external if somebody had. An internal path counts only where the closure already holds
 * it, which is the graph having answered the same question about that file.
 *
 * Anything else is silence, deliberately. An unresolved specifier could be either, and a package
 * the manifest does not declare is a broken import rather than a library — a wrong guess in either
 * direction costs a dismissed suggestion rather than a false one, which is the property the catalog
 * is built to preserve.
 */
export function rendersAnImportedClientComponent(
  file: SourceFileRecord,
  graph: ModuleGraph,
): boolean {
  if (file.jsxElements.length === 0) return false;

  // The leading identifier of the tag: `Foo` for `<Foo>`, and for `<Foo.Bar>` too, since the
  // namespace is the imported name. A lower-case tag is an HTML element and never an import.
  const rendered = new Set(
    file.jsxElements
      .map((element) => element.tag.split(".")[0] ?? "")
      .filter((tag) => tag !== "" && tag[0] === tag[0]?.toUpperCase()),
  );
  if (rendered.size === 0) return false;

  const resolutionOf = new Map(
    file.moduleReferences.map((reference) => [reference.specifier, reference.resolution]),
  );
  for (const [specifier, bindings] of file.imports) {
    if (!bindings.some((binding) => !binding.typeOnly && rendered.has(binding.local))) continue;
    const resolution = resolutionOf.get(specifier);
    if (resolution === undefined) continue;
    if (resolution.kind === "external") return true;
    if (resolution.kind === "missing-package" && resolution.declared === "yes") return true;
    if (resolution.kind === "internal" && graph.clientClosure.has(resolution.path)) return true;
  }
  return false;
}
