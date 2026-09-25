import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Uppdragsradarn – konsultuppdrag på ett ställe",
  description: "Samlar publicerade konsultuppdrag från uppdragsportaler och filtrerar dem på dina nyckelord.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  );
}
