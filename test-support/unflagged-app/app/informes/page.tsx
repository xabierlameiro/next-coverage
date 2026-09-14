// Case: `'use cache'`. The same shape as `overconfigured-app/app/datos/page.tsx` — a server-side
// call carrying neither `cache` nor `next` — in a project with `cacheComponents` on, so the
// directive is the entry the flag hands it to and the extended `fetch` must stay quiet.
export default async function Informes() {
  const respuesta = await fetch('https://api.ejemplo.com/informes');
  const informes: { titulo: string }[] = await respuesta.json();
  return (
    <ul>
      {informes.map((informe) => (
        <li key={informe.titulo}>{informe.titulo}</li>
      ))}
    </ul>
  );
}
