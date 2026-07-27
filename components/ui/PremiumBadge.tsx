"use client";

import { Crown } from "lucide-react";
import { clsx } from "clsx";
import type { PremiumTierId } from "@/lib/premium-config";

const TIER_GRADIENT: Record<Exclude<PremiumTierId, "none">, string> = {
  silver: "from-gray-200 to-gray-400 text-black",
  gold: "from-gold-glow to-gold text-black",
  diamond: "from-primary-glow to-primary text-white",
};

const TIER_LABEL: Record<Exclude<PremiumTierId, "none">, string> = {
  silver: "Silver",
  gold: "Gold",
  diamond: "Diamond",
};

interface PremiumBadgeProps {
  tier: PremiumTierId;
  size?: "sm" | "md";
  className?: string;
}

/** Reused wherever Premium status needs a visual badge: profile header,
 * leaderboard rows, and the Premium status card. Renders nothing for
 * non-Premium users so callers can drop it in unconditionally. */
export function PremiumBadge({ tier, size = "md", className }: PremiumBadgeProps) {
  if (tier === "none") return null;

  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-gradient-to-br font-semibold shadow-glow-gold",
        TIER_GRADIENT[tier],
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
        className
      )}
    >
      <Crown className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} aria-hidden="true" />
      {TIER_LABEL[tier]}
    </span>
  );
}
