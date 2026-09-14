import { Suspense } from 'react';
import Ingresos from './Ingresos';
import Navegacion from './Navegacion';
import Visitas from './Visitas';

// For `file-conventions/parallel-routes`: one layout composing two independently loading
// boundaries, which is the shape its documentation gives as the reason to reach for slots. There
// is no slot anywhere in this project, so the entry is not adopted and the condition can argue.
export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <Navegacion />
      {children}
      <Suspense fallback={<p>Cargando ingresos…</p>}>
        <Ingresos />
      </Suspense>
      <Suspense fallback={<p>Cargando visitas…</p>}>
        <Visitas />
      </Suspense>
    </div>
  );
}
