"use client";

import { GlassCard } from "@/components/ui/GlassCard";
import { RewardNode } from "@/components/features/season-pass/RewardNode";
import type { SeasonTrackNode } from "@/lib/season-engine";

interface FreeTrackProps {
  track: SeasonTrackNode[];
  onClaim: (level: number) => void;
}

export function FreeTrack({ track, onClaim }: FreeTrackProps) {
  return (
    <GlassCard className="p-4">
      <p className="mb-3 text-sm font-medium text-white">Free Track</p>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {track.map((node) => (
          <RewardNode
            key={node.level}
            level={node.level}
            reward={node.free}
            unlocked={node.unlocked}
            claimed={node.freeClaimed}
            claimable={node.unlocked && !node.freeClaimed && !!node.free}
            variant="free"
            onClaim={() => onClaim(node.level)}
          />
        ))}
      </div>
    </GlassCard>
  );
}
