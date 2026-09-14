import Link from 'next/link';

export default function Navegacion() {
  return (
    <nav>
      <Link href="/galeria">Galeria</Link>
      <a href="/analitica">Analitica</a>
    </nav>
  );
}
