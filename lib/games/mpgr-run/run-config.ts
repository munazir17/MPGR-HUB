// lib/games/mpgr-run/run-config.ts
//
// All MPGR Run tuning lives here — nowhere else. The client render loop
// (components/features/games/mpgr-run/RunGame.tsx), the spawn manager
// (spawn-manager.ts), the difficulty resolver (difficulty.ts), and the
// deterministic scoring/anti-cheat modules (run-score.ts, run-validation.ts)
// all import these same numbers, so "what the game actually allows" and
// "what the validator accepts" can never drift apart.
//
// Visual asset paths (character/obstacle/collectible/power-up/environment
// artwork under public/games/mpgr-run/) live separately in run-assets.ts —
// this file stays pure gameplay tuning, no paths.

import type { GameId } from "../game-types";

export const MPGR_RUN_GAME_ID: GameId = "mpgr-run";

// --- World / lanes -----------------------------------------------------
// MPGR Run is a fixed-side-view canvas game, so "left/right lanes" are
// implemented as three parallel horizontal tracks stacked vertically on
// screen — the player and every entity carry a `lane` (0 = top, 1 = middle,
// 2 = bottom) and switch tracks instantly on Left/Right input, with the
// visual position smoothed. Jump/slide then operate vertically within
// whichever lane is current.
export const LANE_COUNT = 3;
export const LANE_CENTER_Y = 0.62; // fraction of canvas height — lane 1 (middle) baseline
export const LANE_GAP_PX = 48; // vertical spacing between adjacent lane baselines

export const PLAYER_X = 0.16; // fraction of canvas width, fixed horizontal position
export const PLAYER_SIZE = 30; // px, square hitbox at rest
export const SLIDE_DURATION_MS = 550;
export const SLIDE_HITBOX_SCALE = 0.45; // hitbox height while sliding, as a fraction of PLAYER_SIZE

export const GRAVITY = 2600; // px/s^2 — pulls playerY (height above lane ground) back to 0
export const JUMP_VELOCITY = 850; // px/s, upward (positive = away from ground)

// Speed ramps from BASE_SPEED to MAX_SPEED over RAMP_DURATION_MS of survival.
export const BASE_SPEED = 260; // px/s, world scroll speed
export const MAX_SPEED = 620; // px/s
export const RAMP_DURATION_MS = 60_000;
export const SPEED_TIERS = 5; // used for the "Speed Demon" achievement progress

// 1 world-unit "meter" == this many px of scroll, used to convert
// scrolled px into the displayed distance in meters.
export const PX_PER_METER = 12;

export const COUNTDOWN_SECONDS = 3;

// --- Health / hit handling ----------------------------------------------
export const STARTING_HP = 3;
export const HIT_INVULNERABILITY_MS = 1400; // brief i-frames after taking a hit

// --- Checkpoints ----------------------------------------------------------
export const CHECKPOINT_INTERVAL_M = 500;
export const CHECKPOINT_GRACE_MS = 1200; // brief invulnerability granted on reaching a checkpoint

// --- Power-up tuning ------------------------------------------------------
export const JETPACK_FLY_HEIGHT = 92; // px above lane ground the player holds while jetpack is active
export const MAGNET_RANGE_PX = 200;
export const MAGNET_ATTRACT_MS = 200; // time a collectible spends visibly being pulled in before auto-collecting
export const SPEED_BOOST_MULTIPLIER = 1.4;

// --- Obstacles --------------------------------------------------------------
export type ObstacleType = "spikes" | "crate" | "tnt" | "saw" | "drone" | "barrier";

export interface ObstacleTypeConfig {
  type: ObstacleType;
  /** How the hazard is avoided, purely for documentation — actual collision uses width/groundHeight bands. */
  avoidedBy: "jump" | "slide-or-jump" | "switch-lane";
  width: number;
  height: number;
  /** px above the lane's ground line where the hazard's hitbox begins (0 = sits on the ground). */
  groundHeight: number;
}

export const OBSTACLE_TYPES: Record<ObstacleType, ObstacleTypeConfig> = {
  spikes: { type: "spikes", avoidedBy: "jump", width: 26, height: 24, groundHeight: 0 },
  crate: { type: "crate", avoidedBy: "jump", width: 34, height: 42, groundHeight: 0 },
  tnt: { type: "tnt", avoidedBy: "switch-lane", width: 30, height: 30, groundHeight: 0 },
  saw: { type: "saw", avoidedBy: "slide-or-jump", width: 34, height: 28, groundHeight: 20 },
  drone: { type: "drone", avoidedBy: "slide-or-jump", width: 32, height: 24, groundHeight: 42 },
  barrier: { type: "barrier", avoidedBy: "switch-lane", width: 14, height: 74, groundHeight: 0 },
};

// --- Power-ups --------------------------------------------------------------
export type PowerupType = "magnet" | "shield" | "speed" | "jetpack" | "score2x" | "invincibility";

export interface PowerupTypeConfig {
  type: PowerupType;
  durationMs: number;
  color: string;
  label: string;
}

export const POWERUP_TYPES: Record<PowerupType, PowerupTypeConfig> = {
  magnet: { type: "magnet", durationMs: 8000, color: "#22D3EE", label: "Magnet" },
  shield: { type: "shield", durationMs: 10000, color: "#34D399", label: "Shield" },
  speed: { type: "speed", durationMs: 6000, color: "#FB923C", label: "Speed" },
  jetpack: { type: "jetpack", durationMs: 6000, color: "#A78BFA", label: "Jetpack" },
  score2x: { type: "score2x", durationMs: 10000, color: "#FBBF24", label: "2X Score" },
  invincibility: { type: "invincibility", durationMs: 5000, color: "#F472B6", label: "Invincible" },
};

// --- Collectibles -------------------------------------------------------------
export type CollectibleType = "coin" | "gem" | "xpOrb" | "key" | "chest";

// --- Scoring weights (deterministic — see run-score.ts) --------------------
export const SCORE_PER_METER = 1;
export const SCORE_PER_COIN = 15;
export const SCORE_PER_GEM = 40;
export const SCORE_PER_XP_ORB = 25;
export const SCORE_PER_KEY = 60;
export const SCORE_PER_CHEST = 150;
export const SCORE_PER_OBSTACLE_PASSED = 2;
export const SCORE_PER_SECOND_SURVIVED = 1;
export const SCORE_PER_CHECKPOINT = 30;

export interface CollectibleTypeConfig {
  type: CollectibleType;
  radius: number;
  scoreValue: number;
  /** Relative spawn weight — these five sum to 100 for easy reasoning about odds. */
  weight: number;
  color: string;
}

export const COLLECTIBLE_TYPES: Record<CollectibleType, CollectibleTypeConfig> = {
  coin: { type: "coin", radius: 8, scoreValue: SCORE_PER_COIN, weight: 70, color: "#FCD34D" },
  gem: { type: "gem", radius: 9, scoreValue: SCORE_PER_GEM, weight: 15, color: "#22D3EE" },
  xpOrb: { type: "xpOrb", radius: 8, scoreValue: SCORE_PER_XP_ORB, weight: 8, color: "#60A5FA" },
  key: { type: "key", radius: 8, scoreValue: SCORE_PER_KEY, weight: 5, color: "#FDE68A" },
  chest: { type: "chest", radius: 12, scoreValue: SCORE_PER_CHEST, weight: 2, color: "#F0B90B" },
};

// --- Centralized difficulty system --------------------------------------
// A single ordered list of distance-banded tuning — see difficulty.ts for
// the resolver. Nothing outside this file hardcodes a spawn gap, a moving
// obstacle speed, or an obstacle-type weight; every consumer resolves the
// current band first, then reads its numbers.
export interface DifficultyBand {
  minDistanceM: number;
  label: "easy" | "normal" | "hard" | "extreme";
  obstacleGapPxRange: [number, number];
  collectibleGapPxRange: [number, number];
  powerupGapPxRange: [number, number];
  /** How many of the 3 lanes may simultaneously carry an obstacle at one spawn slot — never all 3, so a safe lane is always guaranteed. */
  maxBlockedLanes: 1 | 2;
  obstacleTypeWeights: Partial<Record<ObstacleType, number>>;
}

export const DIFFICULTY_BANDS: DifficultyBand[] = [
  {
    minDistanceM: 0,
    label: "easy",
    obstacleGapPxRange: [440, 640],
    collectibleGapPxRange: [150, 260],
    powerupGapPxRange: [950, 1500],
    maxBlockedLanes: 1,
    obstacleTypeWeights: { spikes: 40, crate: 35, tnt: 15, saw: 10 },
  },
  {
    minDistanceM: 500,
    label: "normal",
    obstacleGapPxRange: [360, 540],
    collectibleGapPxRange: [130, 240],
    powerupGapPxRange: [850, 1350],
    maxBlockedLanes: 2,
    obstacleTypeWeights: { spikes: 26, crate: 22, tnt: 18, saw: 18, drone: 16 },
  },
  {
    minDistanceM: 1500,
    label: "hard",
    obstacleGapPxRange: [300, 460],
    collectibleGapPxRange: [120, 220],
    powerupGapPxRange: [800, 1250],
    maxBlockedLanes: 2,
    obstacleTypeWeights: { spikes: 18, crate: 16, tnt: 20, saw: 20, drone: 16, barrier: 10 },
  },
  {
    minDistanceM: 3000,
    label: "extreme",
    obstacleGapPxRange: [260, 400],
    collectibleGapPxRange: [110, 200],
    powerupGapPxRange: [750, 1150],
    maxBlockedLanes: 2,
    obstacleTypeWeights: { spikes: 14, crate: 12, tnt: 20, saw: 22, drone: 18, barrier: 14 },
  },
];

// --- Anti-cheat bounds (see run-validation.ts) ------------------------------
// Generous safety margins over the actual max in-game speed/rates so a
// legitimate run is never falsely rejected, while an obviously fabricated
// result still gets caught. This is a client-side sanity filter, not real
// anti-cheat — see the header comment in run-validation.ts.
export const MAX_PLAUSIBLE_SPEED_MPS = ((MAX_SPEED * SPEED_BOOST_MULTIPLIER) / PX_PER_METER) * 1.25;
export const MIN_METERS_PER_COLLECTIBLE = (DIFFICULTY_BANDS[0].collectibleGapPxRange[0] / PX_PER_METER) * 0.4;
export const MIN_METERS_PER_OBSTACLE = (DIFFICULTY_BANDS[DIFFICULTY_BANDS.length - 1].obstacleGapPxRange[0] / PX_PER_METER) * 0.4;
export const MAX_SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes
export const MIN_SESSION_DURATION_MS = 300; // half a jump's worth — anything shorter is not a real run

export const NO_COLLISION_ACHIEVEMENT_MIN_DISTANCE = 500;
export const DAILY_XP_RUN_CAP = 10;
