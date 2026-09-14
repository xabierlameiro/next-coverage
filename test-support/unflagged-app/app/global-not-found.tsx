// The negative case for `global-not-found`: the file exists and `experimental.globalNotFound` is
// not set, so Next.js does not run it. The convention is not adopted here, and the file catches no
// notFound() call — `global-not-found-app` is pinned to the opposite.
export default function GlobalNotFound() {
  return (
    <html lang="es">
      <body>
        <h1>No encontrado</h1>
      </body>
    </html>
  );
}
