'use client';

import { useMemo } from 'react';

export default function Memo() {
  const total = useMemo(() => 1 + 1, []);
  return <p>{total}</p>;
}
