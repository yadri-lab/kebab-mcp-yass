import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "YassMCP — Admin",
  description: "Personal MCP Server Dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
