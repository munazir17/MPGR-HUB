"use client";

import { motion } from "framer-motion";
import { Medal, Award, Trophy, Gem, Diamond, Check, Sparkles, type LucideIcon } from "lucide-react";
import { clsx } from "clsx";
import { GlassCard } from "@/components/ui/GlassCard";
import { HOLDER_TIERS, getHolderCosmetics, type HolderTierId } from "@/lib/holder-tier-config";
import type { HolderTierStatus } from "@/lib/holder-tier-engine";

interface HolderBenefitsProps {
  status?: HolderTierStatus | null;
}

const TIER_ICON: Record<Exclude<HolderTierId, "none">, LucideIcon> = {
  bronze: Medal,
  silver: Award,
  gold: Trophy,
  platinum: Gem,
  diamond: Diamond,
};

const TIER_TAGLINE: Record<Exclude<HolderTierId, "none">, string> = {
  bronze: "Basic holder perks",
  silver: "Boosted governance weight",
  gold: "Premium recognition",
  platinum: "Treasure & priority access",
  diamond: "Our top holder tier",
};

function tierPerks(tierId: Exclude<HolderTierId, "none">): string[] {
  const def = HOLDER_TIERS.find((t) => t.id === tierId)!;
  const perks: string[] = [];

  switch (tierId) {
    case "bronze":
      perks.push("Bronze Holder badge", "Basic Rewards eligibility");
      break;
    case "silver":
      perks.push("Silver Holder badge & frame", "Elevated community reputation");
      break;
    case "gold":
      perks.push("Gold Holder badge & frame", "Premium Badge recognition", "Access to Gold+ holder events");
      break;
    case "platinum":
      perks.push("Platinum Holder badge & frame", "Treasure Bonus event access", "Elevated leaderboard rank");
      break;
    case "diamond":
      perks.push(
        "Diamond Holder badge — our highest badge",
        "Diamond Holder Summit access",
        "Future Governance Priority (coming soon)"
      );
      break;
  }

  perks.push(`${def.votingWeightMultiplier}× governance voting weight`);
  perks.push(`+${def.reputationBonus} community reputation`);
  return perks;
}

export function HolderBenefits({ status }: HolderBenefitsProps) {
  return (
    <GlassCard className="p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-gold" aria-hidden="true" />
        <p className="text-sm font-semibold text-white">Holder Benefits</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {HOLDER_TIERS.map((tierDef, i) => {
          const Icon = TIER_ICON[tierDef.id];
          const cosmetics = getHolderCosmetics(tierDef.id);
          const isCurrent = status?.tier === tierDef.id;
          const perks = tierPerks(tierDef.id);

          return (
            <motion.div
              key={tierDef.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.35 }}
              whileHover={{ y: -3 }}
              className={clsx(
                "relative overflow-hidden rounded-2xl border p-4 transition-colors duration-200",
                isCurrent
                  ? "border-primary/40 bg-primary/[0.06] shadow-glow"
                  : "border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]"
              )}
            >
              {isCurrent && (
                <span className="absolute right-3 top-3 rounded-full bg-primary/20 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary-glow">
                  Current
                </span>
              )}

              <div className="flex items-center gap-2.5">
                <div
                  className={clsx(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                    cosmetics?.badgeClass ?? "bg-gradient-blue"
                  )}
                >
                  <Icon className="h-4 w-4 text-white" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{tierDef.label}</p>
                  <p className="truncate text-[10px] text-muted">{TIER_TAGLINE[tierDef.id]}</p>
                </div>
              </div>

              <ul className="mt-3 space-y-1.5">
                {perks.map((perk) => (
                  <li key={perk} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                    <span>{perk}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          );
        })}
      </div>
    </GlassCard>
  );
}
