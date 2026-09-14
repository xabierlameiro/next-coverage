import type { MetadataRoute } from 'next';

/**
 * Case: `app-icons`. Two sources, and only one of them exists.
 *
 * `/logo-192.png` is served from public/, so it is provided without any convention — this is the
 * half that makes the naive condition wrong, and it must not be reported.
 * `/logo-512.png` is in neither public/ nor app/, so nothing provides it at all.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Unflagged',
    short_name: 'Unflagged',
    start_url: '/',
    display: 'standalone',
    icons: [
      { src: '/logo-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/logo-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
