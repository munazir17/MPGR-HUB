"use client";

import { Check } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { PremiumBadge } from "@/components/ui/PremiumBadge";
import { formatCompactNumber } from "@/lib/format";
import { PREMIUM_TIERS, PREMIUM_XP_MULTIPLIER, PREMIUM_REWARDS_MULTIPLIER } from "@/lib/premium-config";
import type { PremiumTierId } from "@/lib/premium-config";

const BENEFITS = [
  "Premium profile badge",
  "Premium leaderboard badge",
  `${PREMIUM_XP_MULTIPLIER}× XP multiplier`,
  `${PREMIUM_REWARDS_MULTIPLIER}× rewards multiplier`,
  "Premium-only quests",
  "Premium-only achievements",
  "Weekly Treasure Box",
  "Early access to new Mini Games",
  "Profile cosmetics (frame & border)",
];

export function PremiumTierTable({ currentTier }: { currentTier: PremiumTierId }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {PREMIUM_TIERS.map((tier) => {
        const isCurrent = currentTier === tier.id;
        return (
          <GlassCard key={tier.id} className={isCurrent ? "border-gold/40 p-5 shadow-glow-gold" : "p-5"}>
            <div className="flex items-center justify-between">
              <PremiumBadge tier={tier.id} />
              {isCurrent && <span className="text-[10px] font-semibold text-gold">Active</span>}
            </div>

            <p className="mt-3 text-lg font-bold text-white">{tier.label}</p>
            <p className="text-xs text-muted">Lock {formatCompactNumber(tier.minLocked)} MPGR</p>

            <ul className="mt-4 space-y-2">
              {BENEFITS.map((benefit) => (
                <li key={benefit} className="flex items-start gap-2 text-[11px] text-muted">
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                  {benefit}
                </li>
              ))}
            </ul>
          </GlassCard>
        );
      })}
    </div>
  );
}
