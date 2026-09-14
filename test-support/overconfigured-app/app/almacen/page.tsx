// Case: `fetch`, reached through an import. The page calls nothing itself; the plain call lives in
// the helper it renders from, and it runs on the server exactly as if it were written here.
import { existencias } from '../../lib/existencias';

export default async function Almacen() {
  const lineas = await existencias();
  return <p>{lineas.length} referencias</p>;
}
