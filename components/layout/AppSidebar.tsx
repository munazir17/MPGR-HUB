"use client";

// components/layout/AppSidebar.tsx
//
// The app's ONE secondary-navigation menu. The primary experience is the
// MPGR AGENT on Home; bottom/top nav stays minimal (Home | Rewards |
// Profile) and everything else in the MPGR ecosystem — games, staking,
// token lock, seasons, learn content — lives here, opened by the menu
// button in the Navbar (works on mobile and desktop).
//
// Every entry points at an EXISTING route. No new pages, no duplicated
// features — this is pure information architecture.
//
// The visual style is deliberately plain for this pass (structure over
// skin); premium art direction comes in a later design pass.

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  ChevronRight,
  Coins,
  Flame,
  Gamepad2,
  Gift,
  Medal,
  PiggyBank,
  Play,
  User,
  Vault,
  X,
  type LucideIcon,
} from "lucide-react";
import { clsx } from "clsx";
import { BrandMark } from "@/components/brand/BrandMark";

interface SidebarLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface SidebarGroup {
  title: string;
  links: SidebarLink[];
}

// The complete sidebar — deliberately short. Secondary destinations
// that are not listed here (Season, Season Pass, Docs, Whitepaper,
// Roadmap, About, Support, legal) still exist as routes and remain
// reachable from the Home footer; they are just not sidebar entries.
// Existing routes only — do not add entries without a real page.
const SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    title: "Rewards",
    links: [
      { href: "/rewards", label: "Reward Hub", icon: Gift },
      { href: "/leaderboard", label: "Leaderboard", icon: Medal },
    ],
  },
  {
    title: "Play",
    links: [
      { href: "/games", label: "Games", icon: Gamepad2 },
      { href: "/games/mpgr-run", label: "MPGR Run", icon: Play },
    ],
  },
  {
    title: "Ecosystem",
    links: [
      { href: "/staking", label: "Staking", icon: PiggyBank },
      { href: "/app/token-lock", label: "Token Lock", icon: Vault },
      { href: "/burn", label: "Burn", icon: Flame },
      { href: "/token", label: "$MPGR", icon: Coins },
    ],
  },
  {
    title: "Account",
    links: [{ href: "/profile", label: "Profile", icon: User }],
  },
];

interface AppSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function AppSidebar({ open, onClose }: AppSidebarProps) {
  const pathname = usePathname();

  // Close on route change and on Escape; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname?.startsWith(`${href}/`);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
            aria-hidden="true"
          />
          <motion.aside
            key="drawer"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            role="dialog"
            aria-modal="true"
            aria-label="MPGR HUB menu"
            className="fixed inset-y-0 right-0 z-[70] flex w-80 max-w-[86vw] flex-col border-l border-white/[0.08] bg-background shadow-glow-lg"
            data-testid="app-sidebar"
          >
            <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-3.5">
              <BrandMark />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close menu"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {/* Wallet stays reachable from the menu itself. */}
            <div className="border-b border-white/[0.07] px-4 py-3">
              <ConnectButton showBalance={false} />
            </div>

            <nav
              aria-label="MPGR ecosystem"
              className="flex-1 overflow-y-auto px-3 py-3"
            >
              {SIDEBAR_GROUPS.map((group) => (
                <div key={group.title} className="mb-4 last:mb-0">
                  <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
                    {group.title}
                  </p>
                  <ul className="space-y-0.5">
                    {group.links.map((link) => {
                      const Icon = link.icon;
                      const active = isActive(link.href);
                      return (
                        <li key={link.href}>
                          <Link
                            href={link.href}
                            aria-current={active ? "page" : undefined}
                            className={clsx(
                              "flex min-h-[44px] items-center gap-3 rounded-xl px-2.5 text-sm transition-colors",
                              active
                                ? "bg-primary/10 font-semibold text-white"
                                : "font-medium text-muted hover:bg-white/[0.05] hover:text-white",
                            )}
                          >
                            <Icon
                              className={clsx("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted")}
                              aria-hidden="true"
                            />
                            <span className="flex-1">{link.label}</span>
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/20" aria-hidden="true" />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

/** The menu trigger rendered in the Navbar. */
export function AppSidebarMenuButton({ onClick, open }: { onClick: () => void; open: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? "Close menu" : "Open menu"}
      aria-expanded={open}
      aria-haspopup="dialog"
      className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-surface text-muted transition-colors hover:border-primary/30 hover:text-white"
      data-testid="app-sidebar-menu-button"
    >
      {open ? (
        <X className="h-5 w-5" aria-hidden="true" />
      ) : (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
          <path
            d="M4 7h16M4 12h16M4 17h10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
