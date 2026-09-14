// The negative that separates the scope from the file. One function is cached and reads nothing
// that identifies the request; another reads the request and is not cached. A condition correlating
// the directive and the read per file reports this page, and what it would say about the cached
// scope is false.
import { cookies } from 'next/headers';

async function etiqueta() {
  'use cache';
  return 'estable';
}

async function tema() {
  return (await cookies()).get('tema')?.value ?? 'claro';
}

export default async function Mixto() {
  return (
    <p>
      {await etiqueta()} · {await tema()}
    </p>
  );
}
