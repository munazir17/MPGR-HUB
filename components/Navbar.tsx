"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { clsx } from "clsx";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/season", label: "Season" },
  { href: "/rewards", label: "Rewards" },
  { href: "/staking", label: "Staking" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/profile", label: "Profile" },
];

export function Navbar() {
  const pathname = usePathname();

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

          <nav className="hidden gap-5 sm:flex">
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={clsx(
                    "relative py-1 text-sm transition-colors duration-200",
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

        <ConnectButton showBalance={false} />
      </div>
    </motion.header>
  );
}
