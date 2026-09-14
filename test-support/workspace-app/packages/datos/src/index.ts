// The whole point of the fixture: a request API called from a linked package rather than from the
// app. Before the workspace walk this file was never opened, and `cookies` read as unused.
import { cookies } from 'next/headers';

export async function sesionActual() {
  return (await cookies()).get('sesion')?.value;
}
