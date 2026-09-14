// Case: `authInterrupts`. This convention only renders when experimental.authInterrupts is on,
// and next.config.ts does not set it. The file is here, and Next.js never reaches it.
export default function Forbidden() {
  return <p>No tienes acceso a esta seccion.</p>;
}
