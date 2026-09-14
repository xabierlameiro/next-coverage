import { unstable_noStore } from 'next/cache';

export default async function SinCache() {
  unstable_noStore();
  return <p>{Date.now()}</p>;
}
