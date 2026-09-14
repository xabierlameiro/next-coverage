// The convention this project exists for. The installed documentation states that this file and a
// root `not-found` alike handle unmatched URLs for the whole application, so a `notFound()` call
// anywhere in this project is caught here.
export default function GlobalNotFound() {
  return (
    <html lang="es">
      <body>
        <h1>No encontrado</h1>
      </body>
    </html>
  );
}
