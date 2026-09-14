// The negative. The same read in a scope that already carries the private variant: that file is
// the answer to the condition, not an instance of it.
import { headers } from 'next/headers';

export default async function Privado() {
  'use cache: private';
  const idioma = (await headers()).get('accept-language') ?? 'es';
  return <p>Idioma: {idioma}</p>;
}
