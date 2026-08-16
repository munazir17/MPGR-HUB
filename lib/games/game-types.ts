// lib/games/game-types.ts
//
// Games Platform Foundation — shared types.
//
// This is the contract every game (MPGR Run today, MPGR Clicker / Memory
// Challenge / Space Shooter / 2048 / Pet Raising / Speed Run / Roguelike /
// AI Battle Arena later) is built against. Nothing here is MPGR-Run-
// specific — game-specific fields live in each game's own module.
//
// Mirrors the discipline already used by lib/staking/staking-types.ts and
// lib/rewards/reward-types.ts: one shared types file, every other module
// in lib/games/ and components/features/games/ imports from here instead
// of re-declaring shapes.

export type GameId =
  | "mpgr-run"
  | "mpgr-clicker"
  | "memory-challenge"
  | "space-shooter"
  | "2048-daily"
  | "pet-raising"
  | "speed-run"
  | "roguelike-rpg"
  | "ai-battle-arena";

export type GameCategory =
  | "arcade"
  | "puzzle"
  | "casual"
  | "competitive"
  | "rpg"
  | "strategy";

export type GameDifficulty = "easy" | "medium" | "hard" | "extreme";

export type GameStatus = "playable" | "coming_soon";

/** Static, non-user-specific description of a game — registry entry shape. */
export interface GameDefinition {
  id: GameId;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: GameCategory;
  difficulty: GameDifficulty;

  /** Rough estimated play time per session, e.g. "30s–2min". */
  estimatedPlayTime: string;

  status: GameStatus;

  /** Emoji used as the game's icon across the hub — no external image assets required. */
  icon: string;

  /** Tailwind gradient classes used for the game's card identity accent. */
  accentGradient: string;

  route: string;

  supportsLeaderboard: boolean;
  supportsXP: boolean;
  supportsSeasonPoints: boolean;

  featured?: boolean;
}

/** Lifecycle states for a single play session — shared by every game. */
export type GameSessionStatus =
  | "idle"
  | "countdown"
  | "running"
  | "paused"
  | "game_over";

/**
 * A single play session.
 *
 * Game-specific stats (distance, coins, combo, grid state, pet state, etc.)
 * are NOT part of this shared shape. Each game module extends it with its
 * own result payload.
 */
export interface GameSessionMeta {
  sessionId: string;
  gameId: GameId;

  /** Lowercased wallet address, or null for a not-connected/anonymous run. */
  walletAddress: string | null;

  startedAt: string;
  endedAt: string | null;

  /**
   * Scoring/logic version.
   *
   * Lets a future season change the score formula safely without invalidating
   * or misreading old sessions.
   */
  gameVersion: string;

  status: GameSessionStatus;
}

/** Result of validating a completed session against anti-cheat bounds. */
export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Rewards computed (and, where applicable, actually granted)
 * for a completed run.
 */
export interface GameRewardOutcome {
  xpAwarded: number;
  xpAwardedReason: string | null;

  /**
   * Season Points are never awarded directly.
   * They are derived automatically from XP history by lib/xp-engine.ts.
   *
   * This field reports how much of the XP above will count toward
   * the current season.
   */
  seasonPointsContribution: number;

  dailyCapReached: boolean;

  newlyUnlockedAchievementIds: string[];
}

/**
 * Per-game, per-wallet aggregate stats used for:
 * - achievements
 * - progress
 * - personal bests
 * - future competitive validation
 */
export interface GameStatsRecord {
  gameId: GameId;
  walletAddress: string;

  totalRuns: number;
  totalValidRuns: number;

  bestScore: number;
  bestDistance: number;
  bestCoins: number;
  bestDurationMs: number;

  noCollisionRuns: number;
  totalCoinsCollected: number;
  maxSpeedTierReached: number;

  lastPlayedAt: string | null;

  /**
   * Runs that earned XP today.
   *
   * Key format is a UTC date key and naturally resets as the date changes.
   */
  xpAwardedRunsByDate: Record<string, number>;

  /**
   * Session IDs already processed.
   *
   * Prevents duplicate submission/reward processing.
   */
  processedSessionIds: string[];

  /**
   * Free-form per-game numeric extension bag.
   *
   * Keeps this shared contract generic (per the file-level note above) while
   * still giving each game's own reward module a persisted place to track
   * stats that are specific to it — e.g. MPGR Run's gem/orb/key/chest/
   * power-up counters live here as `custom.totalGemsCollected`, etc. Nothing
   * in this shared file ever reads or hardcodes a specific key.
   */
  custom: Record<string, number>;
}
