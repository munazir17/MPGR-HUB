"use client";

import { AchievementCard } from "@/components/ui/AchievementCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { Achievement } from "@/lib/xp-engine";

interface SeasonMissionsProps {
  missions: Achievement[];
  onClaim: (id: string) => void;
}

export function SeasonMissions({ missions, onClaim }: SeasonMissionsProps) {
  return (
    <div>
      <SectionHeader title="Season Missions" subtitle="Bonus Season XP for completing these" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {missions.map((mission) => (
          <AchievementCard key={mission.id} achievement={mission} onClaim={() => onClaim(mission.id)} />
        ))}
      </div>
    </div>
  );
}
