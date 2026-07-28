// Season Pass — Phase 2C, Module 2.
//
// Reuses the SAME season already used across MPGR HUB (Rewards page season
// milestones, the existing /season page, Season stat on the dashboard) via
// lib/xp-engine.ts's getSeasonStart/getSeasonEnd/getSeasonNumber/
// getSeasonPoints. Season Pass adds a reward-track layer on top of that
// existing season — it does not introduce a second season concept.

export type SeasonRewardKind = "mpgr" | "xp" | "cosmetic";

export interface SeasonReward {
  label: string;
  kind: SeasonRewardKind;
  amount: number;
}

export interface SeasonRewardNode {
  level: number;
  free: SeasonReward | null;
  premium: SeasonReward | null;
}

export const SEASON_PASS_CONFIG = {
  maxLevel: 20,
  // Season points (lib/xp-engine.ts getSeasonPoints) required per Season
  // Pass level. Flat/linear by design — deliberately simpler than the
  // account XP level curve.
  pointsPerLevel: 150,
};

function buildRewardTrack(maxLevel: number): SeasonRewardNode[] {
  const nodes: SeasonRewardNode[] = [];
  for (let level = 1; level <= maxLevel; level++) {
    const isMilestone = level % 5 === 0;
    const free: SeasonReward =
      level % 2 === 0
        ? { label: `${level * 25} MPGR`, kind: "mpgr", amount: level * 25 }
        : { label: `${level * 10} Bonus XP`, kind: "xp", amount: level * 10 };
    const premium: SeasonReward = {
      label: isMilestone ? `${level * 100} MPGR + Cosmetic` : `${level * 60} MPGR`,
      kind: isMilestone ? "cosmetic" : "mpgr",
      amount: isMilestone ? level * 100 : level * 60,
    };
    nodes.push({ level, free, premium });
  }
  return nodes;
}

export const SEASON_REWARD_TRACK: SeasonRewardNode[] = buildRewardTrack(SEASON_PASS_CONFIG.maxLevel);

export function getRewardNode(level: number): SeasonRewardNode | undefined {
  return SEASON_REWARD_TRACK.find((n) => n.level === level);
}
