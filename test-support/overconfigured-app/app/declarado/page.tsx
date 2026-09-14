// The negatives for the `fetch` case, kept in their own file so the condition's evidence names
// `app/datos/page.tsx` and nothing else. Each call here already says what it wants.
export default async function Declarado() {
  const sinCache = await fetch('https://api.ejemplo.com/precios', { cache: 'no-store' });
  const conRevalidacion = await fetch('https://api.ejemplo.com/catalogo', {
    next: { revalidate: 600 },
  });
  const forzado = await fetch('https://api.ejemplo.com/estatico', { cache: 'force-cache' });
  // Options built elsewhere: what they carry is not readable, so the call is not one that
  // said nothing.
  const opciones = { cache: 'no-store' } as const;
  const indirecto = await fetch('https://api.ejemplo.com/indirecto', opciones);
  return (
    <p>
      {sinCache.status} {conRevalidacion.status} {forzado.status} {indirecto.status}
    </p>
  );
}
