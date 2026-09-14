import { unstable_noStore } from 'next/cache';
import type { Metadata } from 'next';
import Aviso from './Aviso';

// The negative for `generateViewport`: a metadata object carrying none of the three fields the
// framework moved out.
export const metadata: Metadata = { title: 'Informe', description: 'Cifras del periodo' };

// For `functions/connection`: the same import incomplete-app carries, but this project leaves
// cacheComponents off, and the flag is what decides which replacement the documentation prefers.
// With it on the suggestion goes to `io` instead, which is why incomplete-app cannot hold this one.
export default async function Informe() {
  unstable_noStore();
  return (
    <>
      <p>{Date.now()}</p>
      <Aviso />
    </>
  );
}
