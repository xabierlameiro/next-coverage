import { notFound } from 'next/navigation';

// The call the coverage reading is about. No `not-found` file exists in this segment or above it,
// and before this fixture that made the entry argue for one — beside a `global-not-found` file the
// configuration enables, which catches the call exactly as a root `not-found` would.
export default async function Informe({ params }: { params: Promise<{ id?: string }> }) {
  const { id } = await params;
  if (id === undefined) notFound();
  return <article>{id}</article>;
}
