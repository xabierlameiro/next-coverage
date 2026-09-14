import type { NextConfig } from 'next';

/**
 * Deliberately sets none of the options this project's code argues for. Every absence here is a
 * case: `authInterrupts`, `useOffline` and a `cacheLife` profile are all missing on purpose, and
 * adding any of them silences the condition that exists for it.
 */
const nextConfig: NextConfig = {
  cacheComponents: true,
  reactStrictMode: true,
};

export default nextConfig;
