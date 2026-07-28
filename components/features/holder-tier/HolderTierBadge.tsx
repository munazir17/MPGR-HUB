"use client";

import { Medal, Award, Trophy, Gem, Diamond, type LucideIcon } from "lucide-react";
import { clsx } from "clsx";
import { getHolderCosmetics, type HolderTierId } from "@/lib/holder-tier-config";

const TIER_ICON: Record<Exclude<HolderTierId, "none">, LucideIcon> = {
  bronze: Medal,
  silver: Award,
  gold: Trophy,
  platinum: Gem,
  diamond: Diamond,
};

interface HolderTierBadgeProps {
  tier: HolderTierId;
  size?: "sm" | "md";
  className?: string;
}

export function HolderTierBadge({ tier, size = "md", className }: HolderTierBadgeProps) {
  if (tier === "none") return null;

  const cosmetics = getHolderCosmetics(tier);
  if (!cosmetics) return null;

  const Icon = TIER_ICON[tier];

  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-full font-semibold shadow-glow",
        cosmetics.badgeClass,
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
        className
      )}
    >
      <Icon className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} aria-hidden="true" />
      {cosmetics.badgeLabel}
    </span>
  );
}
