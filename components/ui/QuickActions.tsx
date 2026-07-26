"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { PiggyBank, Vault, Gift, Gamepad2 } from "lucide-react";

interface QuickAction {
  label: string;
  href: string;
  icon: LucideIcon;
  accent: "primary" | "gold";
}

const ACTIONS: QuickAction[] = [
  { label: "Stake", href: "/staking", icon: PiggyBank, accent: "gold" },
  { label: "Lock", href: "/app/token-lock", icon: Vault, accent: "primary" },
  { label: "Claim", href: "/rewards", icon: Gift, accent: "gold" },
  { label: "Play", href: "/games", icon: Gamepad2, accent: "primary" },
];

export function QuickActions() {
  return (
    <div className="grid grid-cols-4 gap-3">
      {ACTIONS.map((action) => {
        const Icon = action.icon;
        const isGold = action.accent === "gold";
        return (
          <Link key={action.label} href={action.href}>
            <motion.div
              whileHover={{ y: -2, scale: 1.02 }}
              whileTap={{ scale: 0.96 }}
              className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 text-center backdrop-blur-xl transition-colors duration-200 hover:border-white/15 hover:bg-white/[0.06]"
            >
              <div
                className={
                  isGold
                    ? "flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-gold-glow/25 to-gold/10 ring-1 ring-gold/25 shadow-glow-gold"
                    : "flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/25 to-primary/10 ring-1 ring-primary/25 shadow-glow"
                }
              >
                <Icon className={isGold ? "h-5 w-5 text-gold" : "h-5 w-5 text-primary"} aria-hidden="true" />
              </div>
              <p className="text-xs font-semibold text-white">{action.label}</p>
            </motion.div>
          </Link>
        );
      })}
    </div>
  );
}
