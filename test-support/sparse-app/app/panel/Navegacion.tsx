'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Case: `useSelectedLayoutSegment`. Rendered by `layout.tsx`, and it works out which child is
// active by comparing the pathname against paths written down here. The hook returns the active
// segment one level below the layout, which is the same answer without the strings.
export default function Navegacion() {
  const pathname = usePathname();
  return (
    <nav>
      <Link href="/panel/ingresos" aria-current={pathname === '/panel/ingresos' ? 'page' : undefined}>
        Ingresos
      </Link>
      <Link href="/panel/visitas" aria-current={pathname === '/panel/visitas' ? 'page' : undefined}>
        Visitas
      </Link>
    </nav>
  );
}
