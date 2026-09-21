"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { clsx } from "clsx";
import { BrandMark } from "@/components/brand/BrandMark";
import { HolderTierBadge } from "@/components/features/holder-tier/HolderTierBadge";
import { useHolderTier } from "@/lib/useHolderTier";

// Top nav mirrors the bottom nav: Home | Rewards | Profile. The Stocks
// entry was removed when the Base Stocks terminal moved into Home's
// MPGR AGENT (no separate Stocks tab anymore).
const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/rewards", label: "Rewards" },
  { href: "/profile", label: "Profile" },
];

export function Navbar() {
  const pathname = usePathname();
  const { isConnected } = useAccount();
  const { status: holderTierStatus } = useHolderTier();

  return (
    <header
      className="sticky top-0 z-50 border-b border-white/[0.07] bg-background/90 backdrop-blur-md"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-7">
          <BrandMark />

          <nav className="hidden gap-6 sm:flex">
            {NAV_LINKS.map((link) => {
              const isActive =
                link.href === "/"
                  ? pathname === "/"
                  : pathname === link.href || pathname?.startsWith(`${link.href}/`);
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
                      className="absolute -bottom-1 left-0 right-0 h-[2px] rounded-full bg-primary"
                      transition={{ type: "spring", stiffness: 380, damping: 30 }}
                    />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isConnected && holderTierStatus && (
            <div className="hidden items-center gap-1.5 sm:flex">
              <HolderTierBadge tier={holderTierStatus.tier} size="sm" />
            </div>
          )}
          <ConnectButton showBalance={false} />
        </div>
      </div>
    </header>
  );
}
