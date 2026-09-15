import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { MiniAppAutoConnect } from "@/components/MiniAppAutoConnect";
import { RecentPageTracker } from "@/components/RecentPageTracker";
import { ReferralCapture } from "@/components/ReferralCapture";
import { WalletAuthBootstrap } from "@/components/WalletAuthBootstrap";
import { BottomNav } from "@/components/BottomNav";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "MPGR HUB — Play. Trade. Earn. With AI.",
  description:
    "MPGR HUB: a Base-native AI agent for tokenized stocks, x402, MPGR Run, XP, seasons, and rewards.",
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
  },
  openGraph: {
    title: "MPGR HUB",
    description: "Play. Trade. Earn. With AI.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <head>
        <meta name="base:app_id" content="6a79d1c8d198f685bc61e308" />
      </head>

      <body className="min-h-screen bg-background pb-20 font-sans antialiased sm:pb-0">
        <Providers>
          <MiniAppAutoConnect />
          <RecentPageTracker />
          <ReferralCapture />
          <WalletAuthBootstrap />
          {children}
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
