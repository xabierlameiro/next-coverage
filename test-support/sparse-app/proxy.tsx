import type { NextRequest } from 'next/server';

// A `.tsx` proxy: the extension is the point. The documented default page extensions include it,
// and this project is pinned to holding the convention under one that is not `.ts` or `.js`.
export default function proxy(request: NextRequest) {
  return request;
}
