/**
 * The entries that answered with a refusal when the prohibition on reopening one was lifted, frozen
 * at that moment because nothing else can record it: a conversion replaces the refusal with a
 * predicate, so by the time one has happened the evidence that there was ever a refusal is the
 * `reopenedFrom` this list exists to make compulsory.
 *
 * Fifty-seven ids, read off `ALL_PREDICATES` at 305a97d. It does not grow. An entry examined and
 * refused after this point is a refusal nobody reversed, and reopening it is a decision that gets
 * made — and recorded — the way this one was.
 */
export const REFUSED_WHEN_THE_RULE_CHANGED: ReadonlySet<string> = new Set([
  "config/next-config-js/adapterPath",
  "config/next-config-js/allowedDevOrigins",
  "config/next-config-js/assetPrefix",
  "config/next-config-js/basePath",
  "config/next-config-js/cacheComponents",
  "config/next-config-js/cacheHandlers",
  "config/next-config-js/compress",
  "config/next-config-js/crossOrigin",
  "config/next-config-js/cssChunking",
  "config/next-config-js/deploymentId",
  "config/next-config-js/devIndicators",
  "config/next-config-js/distDir",
  "config/next-config-js/env",
  "config/next-config-js/expireTime",
  "config/next-config-js/exportPathMap",
  "config/next-config-js/generateBuildId",
  "config/next-config-js/generateEtags",
  "config/next-config-js/headers",
  "config/next-config-js/htmlLimitedBots",
  "config/next-config-js/httpAgentOptions",
  "config/next-config-js/images",
  "config/next-config-js/inlineCss",
  "config/next-config-js/instrumentationClientInject",
  "config/next-config-js/logging",
  "config/next-config-js/mdxRs",
  "config/next-config-js/onDemandEntries",
  "config/next-config-js/optimizePackageImports",
  "config/next-config-js/output",
  "config/next-config-js/outputHashSalt",
  "config/next-config-js/pageExtensions",
  "config/next-config-js/partialPrefetching",
  "config/next-config-js/poweredByHeader",
  "config/next-config-js/prefetchInlining",
  "config/next-config-js/productionBrowserSourceMaps",
  "config/next-config-js/proxyClientMaxBodySize",
  "config/next-config-js/reactMaxHeadersLength",
  "config/next-config-js/reactStrictMode",
  "config/next-config-js/redirects",
  "config/next-config-js/rewrites",
  "config/next-config-js/sassOptions",
  "config/next-config-js/serverActions",
  "config/next-config-js/serverExternalPackages",
  "config/next-config-js/staleTimes",
  "config/next-config-js/supportsImmutableAssets",
  "config/next-config-js/taint",
  "config/next-config-js/transpilePackages",
  "config/next-config-js/turbopack",
  "config/next-config-js/turbopackChunking",
  "config/next-config-js/turbopackLocalPostcssConfig",
  "config/next-config-js/turbopackMemoryEviction",
  "config/next-config-js/turbopackRustReactCompiler",
  "config/next-config-js/typescript",
  "config/next-config-js/useLightningcss",
  "config/next-config-js/useTypeScriptCli",
  "config/next-config-js/viewTransition",
  "config/next-config-js/webVitalsAttribution",
  "config/next-config-js/webpack",
]);

/**
 * The reopened conditions whose objection no reading available to this tool can answer, so no
 * evidence can promote them out of the strict preset.
 *
 * The framing change lets a withheld condition be promoted where a project's evidence answers the
 * objection its refusal recorded. These two have objections that name a measurement: the size the
 * chunker splits at, and the memory a build holds. `RecordedWeights` carries first-load bytes by
 * route URL and nothing about chunk boundaries, and nothing this tool reads records a build's
 * memory at all. Answering either would need a benchmark, which is not evidence a working tree can
 * supply.
 *
 * So they are not filed as awaiting evidence, which would put them in the same queue as conditions
 * somebody could still answer. Registering an id here makes a default-preset condition on it fail
 * assembly rather than arrive for review.
 */
export const UNPROMOTABLE_BY_CONSTRUCTION: ReadonlySet<string> = new Set([
  "config/next-config-js/turbopackChunking",
  "config/next-config-js/turbopackMemoryEviction",
]);

/**
 * The entries that answered with an abstention when the prohibition on reopening one was lifted,
 * frozen at that moment for the reason the refusals above are: a conversion replaces the reason
 * with a predicate, so once one has happened the evidence that there was ever an abstention is the
 * `reopenedFrom` this list exists to make compulsory.
 *
 * Thirty-one ids across the functions, directives and routing domains, read off the catalog at the
 * point the product abstentions began to be argued. It does not grow. An entry abstained after this
 * point is a decision nobody reversed, and reopening it is a decision that gets made — and
 * recorded — the way this one was.
 *
 * Kept apart from the refusals rather than merged with them. A refusal says a condition was tried
 * and came back empty; an abstention says the question is not about code at all. The second is the
 * harder thing to reopen, and a register that could not tell them apart would let the harder case
 * arrive with the easier one's paperwork.
 */
export const ABSTAINED_WHEN_THE_RULE_CHANGED: ReadonlySet<string> = new Set([
  "file-conventions/dynamic-routes",
  "file-conventions/route-segment-config/dynamicParams",
  "file-conventions/route-segment-config/instant",
  "file-conventions/route-segment-config/maxDuration",
  "file-conventions/route-segment-config/prefetch",
  "file-conventions/route-segment-config/runtime",
  "functions/after",
  "functions/catchError",
  "functions/cookies",
  "functions/draft-mode",
  "functions/forbidden",
  "functions/generate-image-metadata",
  "functions/generate-sitemaps",
  "functions/headers",
  "functions/image-response",
  "functions/next-request",
  "functions/next-response",
  "functions/next-root-params",
  "functions/not-found",
  "functions/permanentRedirect",
  "functions/redirect",
  "functions/unauthorized",
  "functions/unstable_rethrow",
  "functions/use-link-status",
  "functions/use-offline",
  "functions/use-params",
  "functions/use-pathname",
  "functions/use-report-web-vitals",
  "functions/use-router",
  "functions/use-search-params",
  "functions/userAgent",
]);
