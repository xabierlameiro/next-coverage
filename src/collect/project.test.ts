import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverProject,
  packageNameAt,
  resolveProjectRoot,
  resolveWorkspaceRoot,
} from "./project.js";

describe("degraded paths", () => {
  it("should stop when no ancestor declares next", () => {
    const dir = mkdtempSync(join(tmpdir(), "next-coverage-empty-"));
    const discovery = discoverProject(dir);
    expect(discovery.kind).toBe("stopped");
    if (discovery.kind !== "stopped") return;
    expect(discovery.reason.kind).toBe("no-project");
  });

  it("should stop when the project has no App Router", () => {
    const dir = mkdtempSync(join(tmpdir(), "next-coverage-pages-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { next: "^16.0.0" } }),
    );
    const discovery = discoverProject(dir);
    expect(discovery.kind).toBe("stopped");
    if (discovery.kind !== "stopped") return;
    expect(discovery.reason.kind).toBe("no-app-router");
  });

  it("should mark the version unresolved when only a range is declared", () => {
    const dir = mkdtempSync(join(tmpdir(), "next-coverage-range-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { next: "^16.0.0" } }),
    );
    writeFileSync(join(dir, "next.config.ts"), "export default {}\n");
    const appDir = join(dir, "app");
    mkdirSync(appDir);
    writeFileSync(join(appDir, "page.tsx"), "export default function P() { return null }\n");
    const discovery = discoverProject(dir);
    if (discovery.kind !== "ok") throw new Error("expected discovery to succeed");
    expect(discovery.project.version.status).toBe("unresolved");
  });

  it("should find no project root above a temp directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "next-coverage-root-"));
    expect(resolveProjectRoot(dir)).toBeUndefined();
  });

  /**
   * `next-coverage .` from inside `app/` is an ordinary invocation, and the walk climbs with
   * `dirname`, which has nowhere to climb from a relative path: `dirname(".")` is `"."`, so the
   * loop stopped on its first step and answered that no project sits above a project.
   */
  it("should climb out of a relative path the same way it climbs out of an absolute one", () => {
    const dir = mkdtempSync(join(tmpdir(), "next-coverage-relative-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { next: "16.3.0" } }),
    );
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "page.tsx"), "export default function P() { return null }\n");
    const previous = process.cwd();
    try {
      process.chdir(join(dir, "app"));
      // Compared through realpath: chdir resolves the symlink macOS puts in front of /tmp.
      expect(resolveProjectRoot(".")).toBe(realpathSync(dir));
      expect(discoverProject(".").kind).toBe("ok");
    } finally {
      process.chdir(previous);
    }
  });
});

describe("the bundler the project's scripts declare", () => {
  /**
   * The flags the reading is settled against, written the way the compiled CLI writes them. Both
   * releases measured — 16.3.0 and 16.2.x — declare `--turbo`, `--turbopack` and `--webpack` on
   * `dev` and `build`, and no release declares `--no-turbopack`. The rest are here because the
   * reader refuses a bin declaring too few flags to be the list.
   */
  const CLI_FLAGS = [
    "--turbo",
    "--turbopack",
    "--webpack",
    "--port",
    "--hostname",
    "--experimental-https",
    "--debug",
    "--profile",
    "--no-mangling",
    "--experimental-build-mode",
    "--experimental-app-only",
    "--keepAliveTimeout",
  ];

  function stubCli(dir: string, flags: readonly string[] = CLI_FLAGS): void {
    const bin = join(dir, "node_modules", "next", "dist", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "next", "package.json"),
      JSON.stringify({ name: "next", version: "16.3.0" }),
    );
    const declarations = flags.map((flag) => `.option('${flag}', 'a flag.')`).join("");
    writeFileSync(join(bin, "next"), `program${declarations};\n`);
  }

  function projectWith(
    scripts: Record<string, string> | undefined,
    cli: { readonly flags?: readonly string[]; readonly installed?: boolean } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "next-coverage-bundler-"));
    const manifest: Record<string, unknown> = { name: "x", dependencies: { next: "16.3.0" } };
    if (scripts !== undefined) manifest.scripts = scripts;
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    const appDir = join(dir, "app");
    mkdirSync(appDir);
    writeFileSync(join(appDir, "page.tsx"), "export default function P() { return null }\n");
    if (cli.installed !== false) stubCli(dir, cli.flags);
    const discovery = discoverProject(dir);
    if (discovery.kind !== "ok") throw new Error("expected discovery to succeed");
    return discovery.project.bundlers;
  }

  it("should read a script passing the webpack flag as running webpack", () => {
    const bundlers = projectWith({ build: "next build --webpack" });
    expect(bundlers.status).toBe("resolved");
    if (bundlers.status !== "resolved") return;
    expect([...bundlers.value]).toEqual(["webpack"]);
  });

  it("should read a script with no flag as running the default", () => {
    // The installed CLI documents Turbopack as the default and webpack as the opt-out.
    const bundlers = projectWith({ build: "next build" });
    if (bundlers.status !== "resolved") throw new Error("expected a reading");
    expect([...bundlers.value]).toEqual(["turbopack"]);
  });

  it("should keep both readings where the scripts disagree", () => {
    const bundlers = projectWith({ dev: "next dev --turbopack", build: "next build --webpack" });
    if (bundlers.status !== "resolved") throw new Error("expected a reading");
    expect([...bundlers.value].sort()).toEqual(["turbopack", "webpack"]);
  });

  it("should resolve nothing where no script invokes the CLI", () => {
    // Saying nothing about how it is built is not saying it uses the default.
    expect(projectWith({ test: "vitest run" }).status).toBe("unresolved");
  });

  it("should resolve nothing where the manifest declares no scripts", () => {
    expect(projectWith(undefined).status).toBe("unresolved");
  });

  it("should not read a flag that only looks like the webpack one", () => {
    const bundlers = projectWith({ build: "next build --webpackery" });
    if (bundlers.status !== "resolved") throw new Error("expected a reading");
    expect([...bundlers.value]).toEqual(["turbopack"]);
  });

  it("should read the older turbopack spelling the CLI still declares", () => {
    const bundlers = projectWith({ build: "next build --turbo" });
    if (bundlers.status !== "resolved") throw new Error("expected a reading");
    expect([...bundlers.value]).toEqual(["turbopack"]);
  });

  it("should read the current turbopack spelling", () => {
    const bundlers = projectWith({ build: "next build --turbopack" });
    if (bundlers.status !== "resolved") throw new Error("expected a reading");
    expect([...bundlers.value]).toEqual(["turbopack"]);
  });

  /**
   * The case that settles the gate. `--no-turbopack` is a spelling no measured release declares, so
   * the command does not run, and a script that does not run says nothing about how the project
   * builds. Reading it as the default would put a project on the wrong side of every gate that
   * rests on this reading — and reading it as webpack would assume a flag the CLI never accepted.
   */
  it("should resolve nothing where the only script picks a bundler the CLI does not declare", () => {
    const bundlers = projectWith({ analyze: "next build --no-turbopack" });
    expect(bundlers.status).toBe("unresolved");
    if (bundlers.status !== "unresolved") return;
    expect(bundlers.reason).toContain("--no-turbopack");
  });

  it("should keep the readings of the scripts that do run beside one that does not", () => {
    const bundlers = projectWith({
      dev: "next dev",
      analyze: "ANALYZE=true next build --no-turbopack",
    });
    if (bundlers.status !== "resolved") throw new Error("expected a reading");
    expect([...bundlers.value]).toEqual(["turbopack"]);
  });

  it("should resolve nothing where the CLI's own flags cannot be read", () => {
    // The package is what says which spellings a release accepts. Without it the reading guesses,
    // and a guess here decides three conditions' gate.
    expect(projectWith({ build: "next build --webpack" }, { installed: false }).status).toBe(
      "unresolved",
    );
  });

  it("should resolve nothing where the bin holds too few flags to be the list", () => {
    // A renamed anchor or a different build finds something other than the declarations, and a
    // short list would read every real flag as one the release does not declare.
    const bundlers = projectWith({ build: "next build --webpack" }, { flags: ["--webpack"] });
    expect(bundlers.status).toBe("unresolved");
  });
});

describe("the workspace a project belongs to", () => {
  /** A monorepo with the app nested two levels below the declaration. */
  function monorepo(declaration: "pnpm" | "manifest" | "none") {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-ws-"));
    mkdirSync(join(root, "apps", "admin"), { recursive: true });
    if (declaration === "pnpm") {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    } else if (declaration === "manifest") {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
      );
    } else {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    }
    writeFileSync(
      join(root, "apps", "admin", "package.json"),
      JSON.stringify({ name: "admin", dependencies: { next: "16.3.0" } }),
    );
    return { root, app: join(root, "apps", "admin") };
  }

  /**
   * The walk that was missing. A monorepo declares its members at the repository root, so a reader
   * starting at the app saw no workspace and treated every linked package as a dependency it could
   * not open.
   */
  it("should find a pnpm workspace declared two levels above the app", () => {
    const { root, app } = monorepo("pnpm");
    expect(resolveWorkspaceRoot(app)).toBe(root);
  });

  it("should find one declared through the manifest's workspaces field", () => {
    const { root, app } = monorepo("manifest");
    expect(resolveWorkspaceRoot(app)).toBe(root);
  });

  it("should find nothing for a project with no such ancestor", () => {
    const { app } = monorepo("none");
    expect(resolveWorkspaceRoot(app)).toBeUndefined();
  });

  it("should find the project itself where it declares the workspace", () => {
    const { root } = monorepo("pnpm");
    expect(resolveWorkspaceRoot(root)).toBe(root);
  });

  it("should read the name a package calls itself", () => {
    const { app } = monorepo("pnpm");
    expect(packageNameAt(app)).toBe("admin");
    expect(packageNameAt(join(app, "nowhere"))).toBeUndefined();
  });
});

describe("a directory that is a workspace root rather than a project", () => {
  function monorepoWith(apps: readonly { name: string; next: boolean; app: boolean }[]) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-mono-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true }));
    for (const member of apps) {
      const directory = join(root, "apps", member.name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name: member.name,
          ...(member.next ? { dependencies: { next: "16.3.0" } } : {}),
        }),
      );
      if (member.app) {
        mkdirSync(join(directory, "app"), { recursive: true });
        writeFileSync(join(directory, "app", "page.tsx"), "export default function P() {}\n");
      }
    }
    return root;
  }

  /**
   * Pointing the tool at a monorepo root is a common mistake, and "no Next.js project found" is
   * true of that directory and useless to somebody standing in a repository full of them.
   */
  it("should name every member app rather than saying it found nothing", () => {
    const root = monorepoWith([
      { name: "admin", next: true, app: true },
      { name: "donor", next: true, app: true },
      { name: "site", next: true, app: true },
    ]);
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    const { reason } = discovery;
    if (reason.kind !== "workspace-root")
      throw new Error(`expected workspace-root, got ${reason.kind}`);
    expect(reason.apps.map((app) => app.directory)).toEqual([
      join(root, "apps", "admin"),
      join(root, "apps", "donor"),
      join(root, "apps", "site"),
    ]);
    expect(reason.apps.every((app) => app.declares === "16.3.0")).toBe(true);
  });

  /**
   * A repository that supports both package managers declares its members twice — pnpm reads
   * `pnpm-workspace.yaml`, npm and yarn read `workspaces` — and shadcn-ui/ui does exactly that.
   * The two lists are one workspace said twice, so each app is offered once.
   */
  it("should name an app once where the workspace is declared in both files", () => {
    const root = monorepoWith([{ name: "v4", next: true, app: true }]);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "apps/v4"] }),
    );
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    const { reason } = discovery;
    if (reason.kind !== "workspace-root") throw new Error("expected workspace-root");
    expect(reason.apps.map((app) => app.directory)).toEqual([join(root, "apps", "v4")]);
  });

  /**
   * A member declaring `next: 'catalog:'` has named a version — pnpm writes it once at the
   * workspace root and every member points at it, which is what sanity-io/next-sanity does.
   * Printing the pointer back reports the indirection instead of the answer.
   */
  it("should name the version a pnpm catalog holds rather than the pointer to it", () => {
    const root = monorepoWith([{ name: "mvp", next: true, app: true }]);
    writeFileSync(
      join(root, "apps", "mvp", "package.json"),
      JSON.stringify({ name: "mvp", dependencies: { next: "catalog:" } }),
    );
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\ncatalog:\n  next: 16.4.0-canary.16\n",
    );
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    const { reason } = discovery;
    if (reason.kind !== "workspace-root") throw new Error("expected workspace-root");
    expect(reason.apps[0]?.declares).toBe("16.4.0-canary.16");
  });

  /**
   * A monorepo root commonly declares `next` itself, to hold the CLI its workspace scripts run.
   * That made it look like a project until the app directory it was never going to hold turned up
   * missing, and the reader was told "has no app directory" about the one directory in the
   * repository where that is not news. Asymmetric-al/core is that shape.
   */
  it("should name the member apps where the workspace root declares next itself", () => {
    const root = monorepoWith([
      { name: "admin", next: true, app: true },
      { name: "donor", next: true, app: true },
    ]);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["apps/*"],
        dependencies: { next: "16.3.0" },
      }),
    );
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    const { reason } = discovery;
    if (reason.kind !== "workspace-root")
      throw new Error(`expected workspace-root, got ${reason.kind}`);
    expect(reason.apps.map((app) => app.directory)).toEqual([
      join(root, "apps", "admin"),
      join(root, "apps", "donor"),
    ]);
  });

  /** A Pages Router app names its own problem better than a list of its neighbours would. */
  it("should still report the Pages Router where the workspace root is one", () => {
    const root = monorepoWith([{ name: "admin", next: true, app: true }]);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["apps/*"],
        dependencies: { next: "16.3.0" },
      }),
    );
    mkdirSync(join(root, "pages"));
    writeFileSync(
      join(root, "pages", "index.tsx"),
      "export default function P() { return null }\n",
    );
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    expect(discovery.reason.kind).toBe("no-app-router");
  });

  it("should say nothing was found where no member is a Next app", () => {
    const root = monorepoWith([
      { name: "docs", next: false, app: false },
      { name: "cli", next: false, app: false },
    ]);
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    expect(discovery.reason.kind).toBe("no-project");
  });

  /** A member declaring `next` with no app directory of its own is not one to point at. */
  it("should not name a member with no app directory", () => {
    const root = monorepoWith([
      { name: "admin", next: true, app: true },
      { name: "worker", next: true, app: false },
    ]);
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    const { reason } = discovery;
    if (reason.kind !== "workspace-root") throw new Error("expected workspace-root");
    expect(reason.apps.map((app) => app.directory)).toEqual([join(root, "apps", "admin")]);
  });

  /** A single-package project is untouched: the walk finds no workspace and nothing changes. */
  it("should leave a project outside any workspace reporting the reason it already did", () => {
    const alone = mkdtempSync(join(tmpdir(), "next-coverage-alone-"));
    expect(discoverProject(alone).kind).toBe("stopped");
    const discovery = discoverProject(alone);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    expect(discovery.reason.kind).toBe("no-project");
  });
});

describe("a directory that declares nothing but holds apps below it", () => {
  /**
   * A repository is not obliged to declare a workspace, and three of the largest public Next.js
   * repositories do not: the app is `web/`, or `frontend/`, or `platform/frontend/`. Every reader
   * of a declaration walks past them.
   */
  function repositoryWith(
    apps: readonly string[],
    extras: { root?: Record<string, string>; gitignore?: string } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), "next-coverage-undeclared-"));
    for (const [name, contents] of Object.entries(extras.root ?? {})) {
      writeFileSync(join(root, name), contents);
    }
    if (extras.gitignore !== undefined) writeFileSync(join(root, ".gitignore"), extras.gitignore);
    for (const relative of apps) {
      const directory = join(root, ...relative.split("/"));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name: relative, dependencies: { next: "16.3.4" } }),
      );
      mkdirSync(join(directory, "app"), { recursive: true });
      writeFileSync(join(directory, "app", "page.tsx"), "export default function P() {}\n");
    }
    return root;
  }

  function appsBelowOf(root: string): readonly string[] {
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    const { reason } = discovery;
    if (reason.kind !== "apps-below") throw new Error(`expected apps-below, got ${reason.kind}`);
    return reason.apps.map((app) => app.directory);
  }

  it("should name an app one level below a root that declares nothing", () => {
    const root = repositoryWith(["frontend"], {
      root: { "package.json": JSON.stringify({ name: "root", devDependencies: { eslint: "10" } }) },
    });
    expect(appsBelowOf(root)).toEqual([join(root, "frontend")]);
  });

  it("should name an app two levels below a root holding no manifest at all", () => {
    const root = repositoryWith(["platform/frontend"]);
    expect(appsBelowOf(root)).toEqual([join(root, "platform", "frontend")]);
  });

  it("should report the version the app itself declares", () => {
    const root = repositoryWith(["web"]);
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    const { reason } = discovery;
    if (reason.kind !== "apps-below") throw new Error(`expected apps-below, got ${reason.kind}`);
    expect(reason.apps.map((app) => app.declares)).toEqual(["16.3.4"]);
  });

  /**
   * `OWASP/Nest` carries a `pnpm-workspace.yaml` with no `packages:` key, so the declaration reader
   * resolves a workspace root that declares no members at all — and the app is `frontend/`.
   */
  it("should search below a workspace declaration that declares no members", () => {
    const root = repositoryWith(["frontend"], {
      root: {
        "package.json": JSON.stringify({ name: "root" }),
        "pnpm-workspace.yaml": "ignoreScripts: true\n",
      },
    });
    expect(appsBelowOf(root)).toEqual([join(root, "frontend")]);
  });

  it("should say nothing was found where no directory below qualifies", () => {
    const root = repositoryWith([]);
    mkdirSync(join(root, "docs"), { recursive: true });
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    expect(discovery.reason.kind).toBe("no-project");
  });

  /** Two levels is what the measured shapes need; a third would make the bound a matter of taste. */
  it("should not reach an app three levels below", () => {
    const root = repositoryWith(["a/b/frontend"]);
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    expect(discovery.reason.kind).toBe("no-project");
  });

  it("should not offer an installed copy of the framework as an app", () => {
    const root = repositoryWith(["node_modules/next"]);
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    expect(discovery.reason.kind).toBe("no-project");
  });

  it("should not offer a directory the repository ignores", () => {
    const root = repositoryWith(["generated"], { gitignore: "generated\n" });
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    expect(discovery.reason.kind).toBe("no-project");
  });

  /**
   * Breadth-first, and observably so: the reader is being offered somewhere to point the tool, and
   * the app nearest the directory they named is the one they meant.
   */
  it("should answer with the nearest level rather than every level", () => {
    const root = repositoryWith(["web", "platform/frontend"]);
    expect(appsBelowOf(root)).toEqual([join(root, "web")]);
  });

  it("should name every app on the level that answered", () => {
    const root = repositoryWith(["site", "frontend"]);
    expect(appsBelowOf(root)).toEqual([join(root, "frontend"), join(root, "site")]);
  });

  /** The repository said where its apps are, and that is the better authority than a search. */
  it("should leave a declared workspace to answer as a workspace root", () => {
    const root = repositoryWith(["apps/admin", "web"], {
      root: {
        "package.json": JSON.stringify({ name: "root", private: true }),
        "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      },
    });
    const discovery = discoverProject(root);
    if (discovery.kind !== "stopped") throw new Error("expected discovery to stop");
    const { reason } = discovery;
    if (reason.kind !== "workspace-root")
      throw new Error(`expected workspace-root, got ${reason.kind}`);
    expect(reason.apps.map((app) => app.directory)).toEqual([join(root, "apps", "admin")]);
  });

  /** A directory that resolves a project of its own never reaches the search. */
  it("should analyse a project rather than searching below it", () => {
    const root = repositoryWith(["frontend"]);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root", dependencies: { next: "16.3.4" } }),
    );
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app", "page.tsx"), "export default function P() {}\n");
    expect(discoverProject(root).kind).toBe("ok");
  });
});
