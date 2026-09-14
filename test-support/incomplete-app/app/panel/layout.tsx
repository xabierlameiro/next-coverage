export default function PanelLayout({
  children,
  lateral,
}: {
  children: React.ReactNode;
  lateral: React.ReactNode;
}) {
  return (
    <div>
      {children}
      {lateral}
    </div>
  );
}
