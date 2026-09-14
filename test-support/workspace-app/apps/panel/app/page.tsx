import { sesionActual } from '@vendored/datos';

export default async function Panel() {
  return <p>{await sesionActual()}</p>;
}
