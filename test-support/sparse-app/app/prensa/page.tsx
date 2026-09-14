import type { Metadata } from 'next';

// Case: `opengraph-image`. The image is shipped from public/ and the tag pointing at it is
// written out by hand, in a segment holding no image convention — which is the convention's own
// two halves kept apart.
export const metadata: Metadata = {
  title: 'Prensa',
  openGraph: { images: ['/social.png'] },
};

export default function Prensa() {
  return <h1>Prensa</h1>;
}
