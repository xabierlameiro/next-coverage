import type { NextConfig } from 'next';

/**
 * The one flag this project is pinned to. `global-not-found` is honoured only when it is on, so a
 * fixture holding the file with the flag off would be pinned to the opposite case — which is what
 * `unflagged-app` carries.
 */
const nextConfig: NextConfig = {
  experimental: { globalNotFound: true },
};

export default nextConfig;
