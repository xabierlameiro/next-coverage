import type { Metadata } from 'next';

// The negative. The same metadata, in a segment that holds the convention: the convention wins
// there, so the object is redundant or deliberate and neither is a gap.
export const metadata: Metadata = {
  title: 'Difusion',
  openGraph: { images: ['/social.png'] },
};

export default function Difusion() {
  return <h1>Difusion</h1>;
}
