"use client";

import Link from "next/link";
import { ChevronRight, Gift } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { RewardNode } from "@/components/features/season-pass/RewardNode";
import type { SeasonTrackNode } from "@/lib/season-engine";

interface SeasonRewardsPreviewProps {
  track: SeasonTrackNode[];
  currentLevel: number;
}

/** Compact, non-interactive strip of upcoming rewards — used on the Home
 * dashboard to point people at /season-pass without duplicating its logic. */
export function SeasonRewardsPreview({ track, currentLevel }: SeasonRewardsPreviewProps) {
  const upcoming = track.filter((node) => node.level >= currentLevel).slice(0, 4);

  return (
    <GlassCard className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-medium text-white">
          <Gift className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
          Season Pass
        </p>
        <Link href="/season-pass" className="flex items-center gap-0.5 text-xs text-primary">
          View <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {upcoming.map((node) => (
          <RewardNode
            key={node.level}
            level={node.level}
            reward={node.premium ?? node.free}
            unlocked={node.unlocked}
            claimed={node.premiumClaimed || node.freeClaimed}
            claimable={false}
            variant={node.premium ? "premium" : "free"}
          />
        ))}
      </div>
    </GlassCard>
  );
}
