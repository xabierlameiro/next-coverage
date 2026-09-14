import type { NextConfig } from 'next';

/**
 * Pinned to one pair: a custom cache handler configured, and `cacheMaxMemorySize` absent.
 *
 * The page titled `incrementalCacheHandlerPath` asks for the option to be `0` alongside a handler,
 * so a project holding the handler and no size is the shape that condition is written about. No
 * other fixture can carry it: `overconfigured-app` is pinned to the opposite case, where the same
 * page argues that a project without a handler could adopt one.
 *
 * `cacheHandlers`, the plural, is deliberately absent. It is a different option whose own page says
 * the handler it registers manages its own memory, and a fixture holding both would not say which
 * of the two this condition reads.
 */
const nextConfig: NextConfig = {
  cacheHandler: './manejadores/incremental.js',
};

export default nextConfig;
