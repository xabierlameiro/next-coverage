export default async function Visitas() {
  const total = await Promise.resolve(1312);
  return <p>Visitas: {total}</p>;
}
