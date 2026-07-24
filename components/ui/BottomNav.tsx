"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Home, Sparkles, Trophy, User } from "lucide-react";
import { clsx } from "clsx";

const TABS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/season", label: "Season", icon: Sparkles },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/profile", label: "Profile", icon: User },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-background/90 backdrop-blur-xl sm:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="grid grid-cols-4">
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
              <span className={clsx("text-[10px]", active && "font-medium text-white")}>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
