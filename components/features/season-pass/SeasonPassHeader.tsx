"use client";

import { Sparkles } from "lucide-react";
import { PremiumBadge } from "@/components/ui/PremiumBadge";
import type { PremiumTierId } from "@/lib/premium-config";

interface SeasonPassHeaderProps {
  seasonNumber: number;
  tier: PremiumTierId;
}

export function SeasonPassHeader({ seasonNumber, tier }: SeasonPassHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <Sparkles className="h-5 w-5 text-gold" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-bold text-white">Season {seasonNumber} Pass</h1>
          <p className="text-xs text-muted">Earn Season XP to climb the track and unlock rewards</p>
        </div>
      </div>
      <PremiumBadge tier={tier} />
    </div>
  );
}
