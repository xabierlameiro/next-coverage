// Case: `'use cache'`, its second reason. The deprecated predecessor, in a project whose other case
// is a plain fetch: with both firing, each reason has to keep its own file.
import { unstable_cache } from 'next/cache';

export const historico = unstable_cache(async () => [{ titulo: 'Cierre anual' }], ['historico']);
