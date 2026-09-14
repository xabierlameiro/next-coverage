// A remote specifier is neither a package nor a path: it resolves only with `urlImports` set,
// and this project sets it nowhere. The import is the argument for the option.
import confetti from 'https://esm.sh/canvas-confetti@1.9.3';

export default function Remoto() {
  return <button onClick={() => confetti()}>Celebrar</button>;
}
