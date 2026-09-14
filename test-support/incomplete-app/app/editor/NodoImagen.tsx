/* eslint-disable @next/next/no-img-element */
// The file-wide exemption case. A rich-text node view renders whatever the document holds, at
// whatever size the document says, so the project turned the rule off for this file. A suggestion
// to adopt the Image component here argues with a decision its author already wrote down.
export function NodoImagen({ src, alt }: { src: string; alt: string }) {
  return <img src={src} alt={alt} />;
}
