"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { clsx } from "clsx";
import { PremiumBadge } from "@/components/ui/PremiumBadge";
import { HolderTierBadge } from "@/components/features/holder-tier/HolderTierBadge";
import { usePremium } from "@/hooks/usePremium";
import { useHolderTier } from "@/lib/useHolderTier";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/season", label: "Season" },
  { href: "/rewards", label: "Rewards" },
  { href: "/staking", label: "Staking" },
  { href: "/app/token-lock", label: "Token Lock" },
  { href: "/premium", label: "Premium" },
  { href: "/season-pass", label: "Season Pass" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/profile", label: "Profile" },
];

export function Navbar() {
  const pathname = usePathname();
  const { isConnected } = useAccount();
  const { status: premiumStatus } = usePremium();
  const { status: holderTierStatus } = useHolderTier();

  return (
    <motion.header
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="sticky top-0 z-50 border-b border-white/[0.08] bg-background/80 backdrop-blur-xl shadow-soft"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-7">
          <Link
            href="/"
            className="shrink-0 text-lg font-bold tracking-tight text-white"
          >
            MPGR <span className="text-gradient-premium">HUB</span>
          </Link>

          <nav className="hidden gap-5 overflow-x-auto sm:flex">
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={clsx(
                    "relative shrink-0 py-1 text-sm transition-colors duration-200",
                    isActive ? "font-semibold text-white" : "text-muted hover:text-white"
                  )}
                >
                  {link.label}
                  {isActive && (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute -bottom-1 left-0 right-0 h-[2px] rounded-full bg-gradient-premium"
                      transition={{ type: "spring", stiffness: 380, damping: 30 }}
                    />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isConnected && (
            <div className="hidden items-center gap-1.5 sm:flex">
              {premiumStatus && <PremiumBadge tier={premiumStatus.tier} size="sm" />}
              {holderTierStatus && <HolderTierBadge tier={holderTierStatus.tier} size="sm" />}
            </div>
          )}
          <ConnectButton showBalance={false} />
        </div>
      </div>
    </motion.header>
  );
}
