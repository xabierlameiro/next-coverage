// Case: `fetch`. A server-side call carrying neither `cache` nor `next`, in a project with
// `cacheComponents` unset — so the extended `fetch` is the entry the flag hands the shape to,
// and `'use cache'` must stay quiet about it.
export default async function Datos() {
  const respuesta = await fetch('https://api.ejemplo.com/inventario');
  const inventario: { nombre: string }[] = await respuesta.json();
  return (
    <ul>
      {inventario.map((articulo) => (
        <li key={articulo.nombre}>{articulo.nombre}</li>
      ))}
    </ul>
  );
}
