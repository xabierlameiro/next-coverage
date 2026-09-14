'use client';

import { TEXTO_AVISO } from './texto-aviso';

// For the client directive's strict condition: a file that declares the directive and shows none of
// the documented reasons for it — no hook call, no handler attribute, no browser global, no
// `client-only` import, no class component and no context. `app/panel/Navegacion.tsx` and
// `app/panel/Filtros.tsx` are the negatives in this same project: both call a hook, so the
// condition says nothing about them.
export default function Aviso() {
  return <aside>{TEXTO_AVISO}</aside>;
}
