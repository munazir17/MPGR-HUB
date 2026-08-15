// lib/games/mpgr-run/run-config.ts
//
// All MPGR Run tuning lives here — nowhere else. Both the client render
// loop (components/features/games/mpgr-run/RunGame.tsx) and the
// deterministic scoring/anti-cheat modules (run-score.ts, run-validation.ts)
// import these same numbers, so "what the game actually allows" and "what
// the validator accepts" can never drift apart.

import type { GameId } from "../game-types";

export const MPGR_RUN_GAME_ID: GameId = "mpgr-run";

// World units are treated as meters for display purposes.
export const GROUND_Y = 0.82; // fraction of canvas height
export const PLAYER_X = 0.16; // fraction of canvas width, fixed horizontal position
export const PLAYER_SIZE = 34; // px, square hitbox
export const GRAVITY = 2600; // px/s^2 — pulls playerY (height above ground) back to 0
export const JUMP_VELOCITY = 900; // px/s, upward (positive = away from ground)

// Speed ramps from BASE_SPEED to MAX_SPEED over RAMP_DURATION_MS of survival.
export const BASE_SPEED = 260; // px/s, world scroll speed
export const MAX_SPEED = 620; // px/s
export const RAMP_DURATION_MS = 60_000;
export const SPEED_TIERS = 5; // used for the "Speed Demon" achievement progress

// 1 world-unit "meter" == this many px of scroll, used to convert
// scrolled px into the displayed distance in meters.
export const PX_PER_METER = 12;

export const OBSTACLE_MIN_GAP_PX = 260;
export const OBSTACLE_MAX_GAP_PX = 520;
export const COIN_MIN_GAP_PX = 140;
export const COIN_MAX_GAP_PX = 340;

export const COUNTDOWN_SECONDS = 3;

// --- Scoring weights (deterministic — see run-score.ts) --------------------
export const SCORE_PER_METER = 1;
export const SCORE_PER_COIN = 15;
export const SCORE_PER_OBSTACLE_PASSED = 2;
export const SCORE_PER_SECOND_SURVIVED = 1;

// --- Anti-cheat bounds (see run-validation.ts) ------------------------------
// Generous safety margins over the actual max in-game speed/rates so a
// legitimate run is never falsely rejected, while an obviously fabricated
// result still gets caught.
export const MAX_PLAUSIBLE_SPEED_MPS = (MAX_SPEED / PX_PER_METER) * 1.25;
export const MIN_METERS_PER_COIN = (COIN_MIN_GAP_PX / PX_PER_METER) * 0.5;
export const MIN_METERS_PER_OBSTACLE = (OBSTACLE_MIN_GAP_PX / PX_PER_METER) * 0.5;
export const MAX_SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes
export const MIN_SESSION_DURATION_MS = 300; // half a jump's worth — anything shorter is not a real run

export const NO_COLLISION_ACHIEVEMENT_MIN_DISTANCE = 500;
export const DAILY_XP_RUN_CAP = 10;
