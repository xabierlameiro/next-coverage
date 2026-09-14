// Case: `Form`. A raw form navigating to a path it names, with its fields as search parameters —
// the one thing the component is documented for. No method, so it is a GET navigation.
export default function Busqueda() {
  return (
    <form action="/resultados">
      <input name="consulta" />
      <button type="submit">Buscar</button>
    </form>
  );
}
