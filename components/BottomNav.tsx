"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Home, Gamepad2, Gift, Bot, User } from "lucide-react";
import { clsx } from "clsx";

const TABS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/games", label: "Games", icon: Gamepad2 },
  { href: "/rewards", label: "Rewards", icon: Gift },
  { href: "/agent", label: "MPGR Agent", icon: Bot },
  { href: "/profile", label: "Profile", icon: User },
];

// Routes that want the full available viewport for a game and render
// their own compact back/pause controls instead (see RunGame.tsx) — the
// site's 5-tab bottom nav would otherwise eat into that space and is
// redundant with the in-game "Back to Games" link.
const IMMERSIVE_ROUTES = ["/games/mpgr-run"];

export function BottomNav() {
  const pathname = usePathname();

  if (IMMERSIVE_ROUTES.some((route) => pathname?.startsWith(route))) {
    return null;
  }

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-background/90 backdrop-blur-xl sm:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="grid grid-cols-5">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          const Icon = tab.icon;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              aria-label={tab.label}
              className="relative flex min-h-[44px] flex-col items-center justify-center gap-1 py-2.5 text-muted"
            >
              {active && (
                <motion.span
                  layoutId="bottom-nav-active"
                  className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-gradient-premium"
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}

              <Icon className={clsx("h-5 w-5", active && "text-primary")} />

              <span
                className={clsx(
                  "text-[10px]",
                  active && "font-medium text-white"
                )}
              >
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
