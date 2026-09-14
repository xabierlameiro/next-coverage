export default async function Ingresos() {
  const total = await Promise.resolve(42);
  return <p>Ingresos: {total}</p>;
}
