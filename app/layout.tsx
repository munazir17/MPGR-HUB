import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { MiniAppAutoConnect } from "@/components/MiniAppAutoConnect";
import { RecentPageTracker } from "@/components/RecentPageTracker";
import { ReferralCapture } from "@/components/ReferralCapture";
import { BottomNav } from "@/components/BottomNav";

export const metadata: Metadata = {
  title: "MPGR HUB — The Home of MoneyPaiger Ecosystem",
  description:
    "MPGR HUB: quests, XP, leaderboards, staking, and the MoneyPaiger ecosystem on Base.",

  other: {
    "base:app_id": "6a79d1c8d198f685bc61e308",
  },

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
      <body className="min-h-screen bg-background pb-20 antialiased sm:pb-0">
        <Providers>
          <MiniAppAutoConnect />
          <RecentPageTracker />
          <ReferralCapture />
          {children}
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
