export default function Articulo({ params }: { params: { slug: string } }) {
  return <p>{params.slug}</p>;
}
