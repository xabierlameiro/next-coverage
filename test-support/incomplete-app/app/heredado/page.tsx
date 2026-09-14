import { unstable_cache } from 'next/cache';

const leer = unstable_cache(async () => 'valor');

// Tags carried by the options argument: the deprecated helper produces them, and nothing here
// invalidates this one, so the ledger reports it as declared with no counterpart.
const leerEtiquetado = unstable_cache(async () => 'valor', ['clave'], {
  tags: ['heredado-sin-invalidar'],
});

export default async function Heredado() {
  return (
    <p>
      {await leer()} {await leerEtiquetado()}
    </p>
  );
}
