"use client";

import { Crown } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { RewardNode } from "@/components/features/season-pass/RewardNode";
import type { SeasonTrackNode } from "@/lib/season-engine";

interface PremiumTrackProps {
  track: SeasonTrackNode[];
  isPremium: boolean;
  onClaim: (level: number) => void;
}

export function PremiumTrack({ track, isPremium, onClaim }: PremiumTrackProps) {
  return (
    <GlassCard className="relative overflow-hidden p-4">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-gradient-gold opacity-20 blur-3xl"
      />
      <div className="relative mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-medium text-white">
          <Crown className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
          Premium Track
        </p>
        {!isPremium && <span className="text-[10px] font-medium text-gold">Locked — Premium required</span>}
      </div>
      <div className="relative flex gap-2 overflow-x-auto pb-1">
        {track.map((node) => (
          <RewardNode
            key={node.level}
            level={node.level}
            reward={node.premium}
            unlocked={node.unlocked}
            claimed={node.premiumClaimed}
            claimable={isPremium && node.unlocked && !node.premiumClaimed && !!node.premium}
            variant="premium"
            onClaim={() => onClaim(node.level)}
          />
        ))}
      </div>
    </GlassCard>
  );
}
