"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { clsx } from "clsx";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/season", label: "Season" },
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
      className="sticky top-0 z-50 border-b border-white/10 bg-background/80 backdrop-blur-xl"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-6">
          <Link href="/" className="shrink-0 text-lg font-semibold tracking-tight text-white">
            MPGR <span className="text-primary">HUB</span>
          </Link>
          <nav className="hidden gap-4 sm:flex">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={clsx(
                  "text-sm transition-colors",
                  pathname === link.href ? "text-white" : "text-muted hover:text-white"
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <ConnectButton showBalance={false} />
      </div>
    </motion.header>
  );
}
