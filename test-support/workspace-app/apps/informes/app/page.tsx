// The sibling `panel` does not depend on. Its files must not be attributed to `panel`, which is the
// other half of the defect: the old reading kept any member declaring `next`.
import { headers } from 'next/headers';

export default async function Informes() {
  return <p>{(await headers()).get('host')}</p>;
}
