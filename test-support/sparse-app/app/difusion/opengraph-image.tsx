import { ImageResponse } from 'next/og';

// The convention itself, which is what makes the page beside it a negative rather than a case.
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(<div>Difusion</div>, size);
}
