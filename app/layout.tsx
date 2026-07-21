import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { MiniAppReady } from "@/components/MiniAppReady";

export const metadata: Metadata = {
  title: "MPGR HUB — The Home of MoneyPaiger Ecosystem",
  description:
    "MPGR HUB: quests, XP, leaderboards, staking, and the MoneyPaiger ecosystem on Base.",
  openGraph: {
    title: "MPGR HUB",
    description: "The Home of MoneyPaiger Ecosystem",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background antialiased">
        <Providers>
          <MiniAppReady />
          {children}
        </Providers>
      </body>
    </html>
  );
}
