// components/features/games/mpgr-run/RunGameTypes.ts
import type { PowerupType } from "@/lib/games/mpgr-run/run-config";

export type Phase = "idle" | "countdown" | "running" | "paused" | "game_over";

export interface HudSnapshot {
  distance: number;
  score: number;
  coins: number;
  gems: number;
  hp: number;
  speedTier: number;
  activePowerups: { type: PowerupType; remainingMs: number }[];
  checkpointFlash: boolean;
}

export interface RunGameProps {
  address: string;
}
