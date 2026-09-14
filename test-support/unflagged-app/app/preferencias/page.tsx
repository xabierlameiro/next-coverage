// Case: `'use cache: private'`. The scope is keyed on nothing that identifies the request and
// reads what does, which is the shape the private variant is documented for.
import { cookies } from 'next/headers';

export default async function Preferencias() {
  'use cache';
  const tema = (await cookies()).get('tema')?.value ?? 'claro';
  return <p>Tema: {tema}</p>;
}
