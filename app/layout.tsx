import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { MiniAppAutoConnect } from "@/components/MiniAppAutoConnect";
import { RecentPageTracker } from "@/components/RecentPageTracker";
import { ReferralCapture } from "@/components/ReferralCapture";
import { WalletAuthBootstrap } from "@/components/WalletAuthBootstrap";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "MPGR HUB — Play. Trade. Earn. With AI.",
  description:
    "MPGR HUB: a Base-native AI agent for tokenized stocks, x402, MPGR Run, XP, seasons, and rewards.",
  // Small, purpose-built favicon/touch icons. `/icon.png` (1254x1254,
  // ~1.5 MB) stays exactly where it is and is still the mini-app icon
  // referenced by public/.well-known/farcaster.json, but browsers fetch a
  // declared favicon/apple-touch-icon on page loads, so pointing those at
  // the full-size artwork meant ~1.5 MB per cold visit for a 32 px mark.
  icons: {
    icon: "/icon-128.png",
    apple: "/icon-180.png",
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

      <body className="min-h-screen bg-background font-sans antialiased">
        <Providers>
          <MiniAppAutoConnect />
          <RecentPageTracker />
          <ReferralCapture />
          <WalletAuthBootstrap />
          {children}
        </Providers>
      </body>
    </html>
  );
}
