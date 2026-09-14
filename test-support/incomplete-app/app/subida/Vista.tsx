// The line-scoped exemption case, beside a raw img the project exempted nothing for. The first is
// a blob URL from a file the user just picked, which the Image component cannot serve; the second
// carries no directive and stays reportable.
export function Vista({ blobUrl, remoto }: { blobUrl: string; remoto: string }) {
  return (
    <figure>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={blobUrl} alt="Vista previa" />
      <img src={remoto} alt="Remoto" />
    </figure>
  );
}
