async function traer() {
  return 'dato';
}

export default async function Lenta() {
  const dato = await traer();
  return <p>{dato}</p>;
}
