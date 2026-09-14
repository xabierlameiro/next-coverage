'use client';

// A plain fetch on the client side. The framework's extension is a server-side one, so neither
// entry may cite this file.
export function Panel() {
  const cargar = async () => {
    const respuesta = await fetch('https://api.ejemplo.com/interactivo');
    return respuesta.json();
  };
  return <button onClick={cargar}>Cargar</button>;
}
