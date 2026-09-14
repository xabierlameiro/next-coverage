'use client';

// Case: `useOffline`. The hook needs experimental.useOffline to report anything; with the flag
// unset it always returns false, so this banner can never render.
import { useOffline } from 'next/offline';

export function EstadoRed() {
  const offline = useOffline();
  if (!offline) return null;
  return <p role="status">Sin conexion. Los cambios se guardaran al volver.</p>;
}
