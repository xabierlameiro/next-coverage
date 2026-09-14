import type { Metadata } from 'next';

// The negative for `generateMetadata`. A layout above `[id]` that states the title decides what
// the title is, so the page under it has nothing left to argue for.
export const metadata: Metadata = { title: 'Catalogo' };

export default function CatalogoLayout({ children }: { children: React.ReactNode }) {
  return <section>{children}</section>;
}
