import type { MetadataRoute } from 'next';

// For `file-conventions/metadata/robots`: the sitemap has to be present for the robots condition to
// argue, and no robots file announces it. incomplete-app is pinned to the opposite shape — no
// sitemap, so its own `sitemap` condition can fire — which is why this case lives here.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: 'https://ejemplo.test/panel' },
    { url: 'https://ejemplo.test/ajustes' },
  ];
}
