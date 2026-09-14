import type { NextConfig } from 'next';

/**
 * Sets every unexamined option that is a writable key of `NextConfig`, and nothing else. The
 * mirror of `unflagged-app`: that project is pinned to setting none of the options its code argues
 * for, and this one to setting the options nothing else in the corpus reads.
 *
 * Five option pages are deliberately absent, and not because they were missed. `appDir`,
 * `incrementalCacheHandlerPath`, `staticGeneration`, `turbopackFileSystemCache` and
 * `turbopackIgnoreIssue` document names that are not keys of this type. See README.md for the key
 * each one corresponds to.
 *
 * The bundler is Turbopack, so `useLightningcss` and `turbopackMemoryEviction` are set and inert.
 * Presence is what the derived predicate reads, and an option ignored by the bundler is present.
 */
const nextConfig: NextConfig = {
  adapterPath: './adaptadores/despliegue.js',
  allowedDevOrigins: ['origen-local.dev', '*.origen-local.dev'],
  assetPrefix: 'https://cdn.ejemplo.com',
  basePath: '/panel',
  cacheHandlers: {
    default: './manejadores-cache/por-defecto.js',
    remote: './manejadores-cache/remoto.js',
  },
  compress: false,
  crossOrigin: 'anonymous',
  deploymentId: 'despliegue-01',
  devIndicators: { position: 'bottom-right' },
  distDir: 'compilado',
  expireTime: 3600,
  // Pages Router, and inert here. Its page is in the derived surface, so it is named anyway.
  exportPathMap: async () => ({ '/': { page: '/' } }),
  generateEtags: false,
  htmlLimitedBots: /MiRastreador|OtroRastreador/,
  httpAgentOptions: { keepAlive: false },
  instrumentationClientInject: ['./lib/analitica-cliente.js'],
  onDemandEntries: { maxInactiveAge: 25000, pagesBufferLength: 2 },
  outputHashSalt: 'sal-de-despliegue',
  productionBrowserSourceMaps: true,
  reactMaxHeadersLength: 1000,
  supportsImmutableAssets: false,
  trailingSlash: true,
  experimental: {
    cssChunking: 'graph',
    inlineCss: true,
    prefetchInlining: false,
    proxyClientMaxBodySize: '1mb',
    serverComponentsHmrCache: false,
    turbopackChunking: { minChunkSize: 50000, maxChunkCountPerGroup: 40 },
    turbopackLocalPostcssConfig: true,
    // Inert: it needs the filesystem cache, whose page name is not a writable key.
    turbopackMemoryEviction: 'auto',
    // Inert: webpack only, ignored under Turbopack.
    useLightningcss: true,
    useTypeScriptCli: false,
  },
};

export default nextConfig;
