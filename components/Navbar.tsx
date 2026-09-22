"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { clsx } from "clsx";
import { BrandMark } from "@/components/brand/BrandMark";
import { HolderTierBadge } from "@/components/features/holder-tier/HolderTierBadge";
import { AppSidebar, AppSidebarMenuButton } from "@/components/layout/AppSidebar";
import { useHolderTier } from "@/lib/useHolderTier";

// Primary navigation, desktop-first: brand + the five product links,
// then the right cluster (holder tier · wallet · menu). Mobile keeps the
// same brand + right cluster with NO in-header link row — the links
// live in the AppSidebar sheet, so nothing gets squeezed.
//
// The wallet surface is RainbowKit's ConnectButton.Custom — the exact
// same connect/account/chain modals, restyled to the hub's chrome
// (42px, 12px radius, hairline, blue-tinted hover).

const PRIMARY_LINKS = [
  { href: "/", label: "Agent" },
  { href: "/rewards", label: "Rewards" },
  { href: "/staking", label: "Staking" },
  { href: "/games", label: "Games" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

export function Navbar() {
  const { isConnected } = useAccount();
  const { status: holderTierStatus } = useHolderTier();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname?.startsWith(`${href}/`);

  return (
    <>
      <header
        className="sticky top-0 z-50 border-b border-white/[0.08] bg-background/80 backdrop-blur-xl"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto flex h-14 w-full max-w-[1760px] items-center justify-between gap-3 px-4 sm:px-6 lg:h-16 lg:px-8">
          <div className="flex min-w-0 items-center gap-6">
            <BrandMark />

            {/* Desktop primary links (≥1024). Mobile/tablet navigate via
                the sidebar sheet — these never squeeze into the header. */}
            <nav aria-label="Primary" className="hidden items-center gap-0.5 lg:flex">
              {PRIMARY_LINKS.map((link) => {
                const active = isActive(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={clsx(
                      "relative rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors duration-150",
                      active ? "text-white" : "text-muted hover:text-white",
                    )}
                  >
                    {link.label}
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-3 -bottom-2 h-0.5 rounded-full bg-primary"
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

            {/* Wallet — same RainbowKit flow, restyled surface. */}
            <ConnectButton.Custom>
              {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
                const ready = mounted;
                const connected = ready && account;
                return (
                  <div
                    aria-hidden={!ready}
                    style={{ opacity: ready ? 1 : 0, transition: "opacity 120ms linear" }}
                  >
                    {(() => {
                      if (connected && chain?.unsupported) {
                        return (
                          <button
                            type="button"
                            onClick={openChainModal}
                            className="flex h-[42px] items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3.5 text-[13px] font-semibold text-amber-300 transition-colors duration-200 hover:bg-amber-400/15"
                          >
                            Wrong network
                          </button>
                        );
                      }
                      if (connected) {
                        return (
                          <button
                            type="button"
                            onClick={openAccountModal}
                            className="flex h-[42px] items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 font-mono text-[13px] font-medium text-white/90 transition-colors duration-200 hover:border-primary/25 hover:bg-primary/[0.08] hover:text-white"
                          >
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 rounded-full bg-good shadow-[0_0_6px_rgba(61,220,132,0.8)]"
                            />
                            {account.displayName}
                          </button>
                        );
                      }
                      return (
                        <button
                          type="button"
                          onClick={openConnectModal}
                          className="flex h-[42px] items-center rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 text-[13px] font-semibold text-white/90 transition-colors duration-200 hover:border-primary/25 hover:bg-primary/[0.08] hover:text-white"
                        >
                          Connect
                        </button>
                      );
                    })()}
                  </div>
                );
              }}
            </ConnectButton.Custom>

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
