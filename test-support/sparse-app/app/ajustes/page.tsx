import type { Metadata } from 'next';

// Case: `generateViewport`. The framework documents `themeColor` as moved out of metadata and
// into the viewport export; an object still carrying it is the shape, and the object's own keys
// are what say so.
export const metadata: Metadata = {
  title: 'Ajustes',
  themeColor: '#0b1020',
};

export default function Ajustes() {
  return <h1>Ajustes</h1>;
}
