import { guardar } from '../acciones/actions';

// The negatives for `Form`, kept together so the case above cites one file. A form posting to a
// server function is doing something else; a form whose action is an expression is going
// somewhere unknown; a form that posts is not navigating.
export default function Envio({ destino }: { destino: string }) {
  return (
    <>
      <form action={guardar}>
        <input name="nombre" />
      </form>
      <form action={`/enviar/${destino}`}>
        <input name="asunto" />
      </form>
      <form action="/enviar" method="post">
        <input name="cuerpo" />
      </form>
    </>
  );
}
