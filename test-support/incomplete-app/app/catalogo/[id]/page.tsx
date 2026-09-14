export default function Detalle({ params }: { params: { id: string } }) {
  return <p>{params.id}</p>;
}
