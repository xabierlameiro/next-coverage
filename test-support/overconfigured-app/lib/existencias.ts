// Case: `fetch`, outside the route tree. Nothing marks this file as server code but the page that
// imports it: that import is what puts the plain call on the server Next.js runs.
export async function existencias(): Promise<{ referencia: string }[]> {
  const respuesta = await fetch('https://api.ejemplo.com/existencias');
  return respuesta.json();
}
