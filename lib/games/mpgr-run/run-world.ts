/**
 * MPGR Run — world state shape and the pure factory that creates a fresh
 * run. Extracted verbatim from RunGame.tsx (P2-11 follow-up modularization):
 * these types and freshWorld() have no dependency on React state, refs, or
 * component closures, so moving them here is a literal relocation with no
 * behavior change. RunGame.tsx imports World (+ friends) and freshWorld
 * from this file exactly as it used to define them locally.
 */
import {
  BASE_SPEED,
  CHECKPOINT_INTERVAL_M,
  STARTING_HP,
  type PowerupType,
} from "@/lib/games/mpgr-run/run-config";
import type {
  ObstacleEntity,
  CollectibleEntity,
  PowerupEntity,
} from "@/lib/games/mpgr-run/spawn-manager";

interface PlayerState {
  lane: number;
  laneOffset: number; // smoothed screen-space vertical offset toward the current lane's baseline
  playerY: number; // px above the current lane's ground line, 0 = grounded
  velocityY: number;
  sliding: boolean;
  slideUntilMs: number;
  hp: number;
  invulnerableUntilMs: number;
}

/**
 * Cosmetic spark. Positions live in the SAME world space the simulation
 * scrolls in, so the rear-camera renderer can project them with depth:
 *   - `x`    : depth along the track (simulation x units, scrolls toward
 *              the camera exactly like obstacles/collectibles do);
 *   - `lane` : which of the 3 lanes the burst originated in (lateral);
 *   - `lx`   : lateral offset from that lane's centre (world units);
 *   - `y`    : height above the track surface (world units, positive up).
 * `vx`/`vy` drive lateral/vertical spread respectively. Purely visual —
 * the authoritative replay never simulates particles.
 */
interface Particle {
  id: number;
  x: number;
  lane: number;
  lx: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

/** A brief real-artwork overlay (hit explosion, coin/gem burst) — separate from the tiny procedural dot particles above. Same world-space position contract as Particle. */
interface SpriteBurst {
  id: number;
  x: number;
  lane: number;
  y: number;
  sprite: string;
  startMs: number;
  durationMs: number;
  maxSize: number;
}

type ActivePowerups = Partial<Record<PowerupType, number>>; // value = world.elapsedMs when the effect expires

interface RunStatsAccum {
  coins: number;
  gems: number;
  xpOrbs: number;
  keys: number;
  chests: number;
  powerups: number;
  obstaclesPassed: number;
  checkpoints: number;
  hits: number;
}

export interface World {
  player: PlayerState;
  speed: number;
  effectiveSpeed: number;
  elapsedMs: number;
  traveledPx: number;
  obstacles: ObstacleEntity[];
  collectibles: CollectibleEntity[];
  powerups: PowerupEntity[];
  particles: Particle[];
  spriteBursts: SpriteBurst[];
  activePowerups: ActivePowerups;
  stats: RunStatsAccum;
  bonusScore: number;
  nextCheckpointM: number;
  screenShake: number;
  checkpointFlashUntilMs: number;
  hitFlashUntilMs: number;
  gameOver: boolean;
}

export function freshWorld(): World {
  return {
    player: {
      lane: 1,
      laneOffset: 0,
      playerY: 0,
      velocityY: 0,
      sliding: false,
      slideUntilMs: 0,
      hp: STARTING_HP,
      invulnerableUntilMs: 0,
    },
    speed: BASE_SPEED,
    effectiveSpeed: BASE_SPEED,
    elapsedMs: 0,
    traveledPx: 0,
    obstacles: [],
    collectibles: [],
    powerups: [],
    particles: [],
    spriteBursts: [],
    activePowerups: {},
    stats: { coins: 0, gems: 0, xpOrbs: 0, keys: 0, chests: 0, powerups: 0, obstaclesPassed: 0, checkpoints: 0, hits: 0 },
    bonusScore: 0,
    nextCheckpointM: CHECKPOINT_INTERVAL_M,
    screenShake: 0,
    checkpointFlashUntilMs: -Infinity,
    hitFlashUntilMs: -Infinity,
    gameOver: false,
  };
}
