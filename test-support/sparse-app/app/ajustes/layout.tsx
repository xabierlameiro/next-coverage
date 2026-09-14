'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// For `file-conventions/template`: a client layout whose effect runs per navigation, which is the
// work the template convention's documentation names as its purpose. A layout does not remount, so
// the effect is written against the pathname to fake what a template would give for free. There is
// no template file here in any casing, so the entry is not adopted and no casing condition can
// short-circuit this one.
export default function AjustesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useEffect(() => {
    console.log('entrada en', pathname);
  }, [pathname]);
  return <section>{children}</section>;
}
