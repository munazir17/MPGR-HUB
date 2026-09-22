"use client";

import { useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { BrandMark } from "@/components/brand/BrandMark";
import { HolderTierBadge } from "@/components/features/holder-tier/HolderTierBadge";
import { AppSidebar, AppSidebarMenuButton } from "@/components/layout/AppSidebar";
import { useHolderTier } from "@/lib/useHolderTier";

// The header is intentionally minimal: brand (→ Home = the MPGR AGENT),
// holder tier, wallet, and the menu button. Secondary navigation lives
// in the AppSidebar (all ecosystem sections incl. Rewards and Profile)
// on every viewport — phones included, since the bottom tab bar was
// removed. A duplicate link row here would just restate the sidebar.
export function Navbar() {
  const { isConnected } = useAccount();
  const { status: holderTierStatus } = useHolderTier();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <header
        className="sticky top-0 z-50 border-b border-white/[0.07] bg-background/90 backdrop-blur-md"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto flex w-full max-w-[1760px] items-center justify-between gap-2 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-5">
            <BrandMark />

            {isConnected && holderTierStatus && (
              <div className="hidden items-center gap-1.5 sm:flex">
                <HolderTierBadge tier={holderTierStatus.tier} size="sm" />
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <ConnectButton showBalance={false} />
            <AppSidebarMenuButton open={menuOpen} onClick={() => setMenuOpen((v) => !v)} />
          </div>
        </div>
      </header>

      {/* Rendered outside the header: backdrop-blur on the header would
          otherwise become the containing block for the fixed drawer. */}
      <AppSidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}
