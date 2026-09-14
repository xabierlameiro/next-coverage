import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConventionName } from "../collect/conventions.js";
import { pageUrls } from "../collect/routes.js";
import { productionFiles } from "../collect/sources.js";
import type { PredicateContext, PredicateSet, Suggestion, Verdict } from "./types.js";
import { match, NO_MATCH, suggest } from "./types.js";

function metadataFiles(context: PredicateContext, name: ConventionName): string[] {
  return context.tree.nodes
    .flatMap((node) => node.conventions)
    .filter((convention) => convention.name === name && convention.skippedForFlag === undefined)
    .map((convention) => convention.file);
}

/**
 * Icon sources a manifest names that nothing on disk provides.
 *
 * Resolution goes through `public/` as well as the app directory, and that is the half a first
 * attempt at this condition got wrong: a manifest's `src` is a URL, and one served from `public/`
 * is provided without any convention being involved. Checking the conventions alone reported the
 * one fixture with a manifest, which was correct.
 *
 * An absolute URL is skipped. Another host serves it, and nothing here can confirm or deny that.
 */
function iconSourcesNothingProvides(context: PredicateContext): string[] {
  const manifests = metadataFiles(context, "manifest");
  if (manifests.length === 0) return [];

  const appDirectory = context.project.appDirectory.path;
  const publicDirectory = join(context.project.root, "public");
  const missing = new Set<string>();

  for (const manifest of manifests) {
    const record = context.sources.byPath.get(manifest);
    if (record === undefined) continue;
    for (const source of record.srcValues) {
      if (!source.startsWith("/")) continue;
      const relative = source.slice(1);
      if (relative === "") continue;
      const served =
        existsSync(join(publicDirectory, relative)) || existsSync(join(appDirectory, relative));
      if (!served) missing.add(source);
    }
  }
  return [...missing];
}

/** The two conventions that generate a social image and its metadata together. */
const SOCIAL_IMAGE_CONVENTIONS: readonly ConventionName[] = ["opengraph-image", "twitter-image"];

/**
 * Pages and layouts naming a social image by hand where the convention would generate it.
 *
 * The convention produces the image and the metadata that points at it from one file. A metadata
 * object naming a literal path under `public/` is the same two things kept apart: the file is
 * shipped as a static asset, and the tag pointing at it is written out separately and by hand.
 *
 * The path has to resolve. A literal naming a file nothing serves is a different problem — the
 * manifest entry already reports that one — and this condition is about a file that is there.
 *
 * A segment already holding the convention is not the shape, whatever its metadata names: the
 * convention wins there, and the object is either redundant or deliberate.
 */
function metadataNamingAServedSocialImage(context: PredicateContext): string[] {
  const covered = new Set(
    context.tree.nodes
      .filter((node) =>
        node.conventions.some(
          (convention) =>
            SOCIAL_IMAGE_CONVENTIONS.includes(convention.name) &&
            convention.skippedForFlag === undefined,
        ),
      )
      .map((node) => node.directory),
  );
  const publicDirectory = join(context.project.root, "public");

  return productionFiles(context.sources)
    .filter((file) => {
      if (file.socialImagePaths.length === 0) return false;
      if (covered.has(dirname(file.path))) return false;
      return file.socialImagePaths.some(
        (path) =>
          path.startsWith("/") &&
          !path.startsWith("//") &&
          existsSync(join(publicDirectory, path.slice(1))),
      );
    })
    .map((file) => file.path)
    .sort();
}

function usesMetadata(name: ConventionName) {
  return (context: PredicateContext): Verdict => {
    const files = metadataFiles(context, name);
    return files.length === 0 ? NO_MATCH : match(files);
  };
}

/**
 * Files answering on a convention's URL without the convention.
 *
 * The convention is one of three ways to serve `/robots.txt` or `/sitemap.xml`. A file under
 * `public/` is served verbatim on that URL, and a route handler on the same path answers it at
 * request time — `app/robots.txt/route.ts` is a robots file whatever the tree calls it. Reading
 * conventions alone reported both as projects with nothing there, which is the shape of false
 * positive that costs the most trust: a reader looking at their own robots file is told they have
 * none.
 *
 * These two conventions only. They name a fixed URL a project can plausibly serve by hand, which
 * is what makes the question answerable; a convention whose URL depends on the segment it sits in
 * has no single path to look for.
 *
 * Nothing here reads what the file or the handler answers with. Whether the response is a valid
 * robots or sitemap is a different claim than this tool makes, and one the source of a handler
 * does not settle.
 */
function servedWithoutTheConvention(context: PredicateContext, url: string): string[] {
  const found = new Set<string>();

  const asset = join(context.project.root, "public", url.slice(1));
  if (existsSync(asset)) found.add(asset);

  for (const node of context.tree.nodes) {
    if (node.urlPath !== url) continue;
    for (const convention of node.conventions) {
      if (convention.name === "route" && convention.skippedForFlag === undefined) {
        found.add(convention.file);
      }
    }
  }

  return [...found].sort();
}

/**
 * Dismisses the entry where the project already answers on the convention's URL.
 *
 * Not-applicable rather than a silent would-apply, because the two say different things and only
 * one of them is true here: the project has not adopted the convention, and it has ruled the
 * suggestion out by covering the URL another way. That is the explicit signal this bucket is for,
 * and it stays visible with the file that dismisses it as the evidence.
 */
function alreadyAnsweredWithout(url: string) {
  return (context: PredicateContext): Verdict => {
    const files = servedWithoutTheConvention(context, url);
    return files.length === 0
      ? NO_MATCH
      : match(files, `the project already answers on ${url} without the convention`);
  };
}

/**
 * A would-apply heuristic must hold on its own, because it is also evaluated for an API
 * that is already used somewhere. Assuming "only called when absent" produces claims that
 * contradict the report right above them.
 */
export const METADATA_PREDICATES: readonly PredicateSet[] = [
  {
    id: "file-conventions/metadata/sitemap",
    cost: "FS",
    detectUsed: usesMetadata("sitemap"),
    notApplicable: alreadyAnsweredWithout("/sitemap.xml"),
    wouldApply: (context) => {
      if (metadataFiles(context, "sitemap").length > 0) return NO_MATCH;
      // A sitemap only earns its place once there are pages to list, and a route handler is not
      // one of them: this counts what a sitemap would list, not everything the project answers on.
      // The figure is pages served rather than pages worth indexing — whether a page belongs in a
      // sitemap is a decision about the product, and nothing in the code settles it.
      const pages = pageUrls(context.tree);
      return pages.length < 2
        ? NO_MATCH
        : suggest(
            [context.project.appDirectory.path],
            `the project serves ${pages.length} pages and declares no sitemap`,
            "a sitemap file generates the XML from the routes, so crawlers find every page rather than the ones something links to",
          );
    },
  },
  {
    id: "file-conventions/metadata/robots",
    cost: "FS",
    detectUsed: usesMetadata("robots"),
    notApplicable: alreadyAnsweredWithout("/robots.txt"),
    wouldApply: (context) => {
      if (metadataFiles(context, "robots").length > 0) return NO_MATCH;
      const sitemaps = metadataFiles(context, "sitemap");
      return sitemaps.length === 0
        ? NO_MATCH
        : suggest(
            sitemaps,
            "there is a sitemap but no robots file announcing it",
            "a robots file points crawlers at the sitemap and states what may be indexed",
          );
    },
  },
  {
    id: "file-conventions/metadata/manifest",
    cost: "FS",
    detectUsed: usesMetadata("manifest"),
    wouldApply: (context) => {
      if (metadataFiles(context, "manifest").length > 0) return NO_MATCH;
      const appleIcons = metadataFiles(context, "apple-icon");
      return appleIcons.length === 0
        ? NO_MATCH
        : suggest(
            appleIcons,
            "there is an apple icon but no web app manifest",
            "a manifest gives the icon a name, colours and a start URL, so the app can be installed to a home screen",
          );
    },
  },
  {
    id: "file-conventions/metadata/app-icons",
    cost: "FS",
    detectUsed: (context) => {
      const files = [...metadataFiles(context, "icon"), ...metadataFiles(context, "apple-icon")];
      return files.length === 0 ? NO_MATCH : match(files);
    },
    // The mirror of the manifest entry: it argues from an apple icon to a missing manifest, and
    // this argues from a manifest to an icon nothing provides. The evidence is the manifest, and
    // the note names the sources, because the source is what a reader has to go and find.
    wouldApply: (context): Suggestion => {
      const missing = iconSourcesNothingProvides(context);
      return missing.length === 0
        ? NO_MATCH
        : suggest(
            metadataFiles(context, "manifest"),
            `the manifest names ${missing.join(", ")}, which no icon convention or public file provides`,
            "an icon convention generates the file at the path the manifest names, so the reference resolves",
          );
    },
  },
  {
    id: "file-conventions/metadata/opengraph-image",
    // Detection is filesystem work; the condition reads an exported object out of the file, which
    // is the higher of the two and what the entry has to declare.
    cost: "AST",
    detectUsed: (context) => {
      const files = [
        ...metadataFiles(context, "opengraph-image"),
        ...metadataFiles(context, "twitter-image"),
      ];
      return files.length === 0 ? NO_MATCH : match(files);
    },
    wouldApply: (context): Suggestion => {
      const files = metadataNamingAServedSocialImage(context);
      return files.length === 0
        ? NO_MATCH
        : suggest(
            files,
            "these name a social image by a path under public/, in a segment that holds no image convention",
            "the convention generates the image and the tag pointing at it from one file, so the two cannot drift apart and the URL is versioned with the build",
          );
    },
  },
];
