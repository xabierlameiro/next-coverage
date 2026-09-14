'use client';

import { usePathname } from 'next/navigation';

// The negative. The same read, in a file a page renders: a page has no active child to find, so
// the segment hooks answer nothing it asked.
export default function Filtros() {
  const pathname = usePathname();
  return <p>{pathname.startsWith('/panel') ? 'Filtros del panel' : 'Filtros'}</p>;
}
