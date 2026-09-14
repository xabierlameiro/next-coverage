import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: { authInterrupts: true },
};

export default nextConfig;
