// lib/games/mpgr-run/spawn-manager.ts
//
// Reliable, difficulty-aware spawn logic for obstacles, collectibles, and
// power-ups. Kept as pure functions operating on the current entity arrays
// so the render loop in RunGame.tsx stays a thin caller — every rule about
// *what* can spawn *where* lives here, not scattered through the component.
//
// Safety guarantee: at any single obstacle "slot", at most
// `band.maxBlockedLanes` of the 3 lanes are ever occupied — never all 3 —
// so a safe lane always exists and impossible patterns can't happen.

import {
  LANE_COUNT,
  OBSTACLE_TYPES,
  COLLECTIBLE_TYPES,
  POWERUP_TYPES,
  type DifficultyBand,
  type ObstacleType,
  type CollectibleType,
  type PowerupType,
} from "./run-config";
import type { DeterministicRng } from "./deterministic-rng";

export interface ObstacleEntity {
  id: number;
  type: ObstacleType;
  lane: number;
  x: number;
  width: number;
  height: number;
  groundHeight: number;
  passed: boolean;
  hit: boolean;
}

export interface CollectibleEntity {
  id: number;
  type: CollectibleType;
  lane: number;
  x: number;
  radius: number;
  collected: boolean;
  magnetizedAtMs?: number;
}

export interface PowerupEntity {
  id: number;
  type: PowerupType;
  lane: number;
  x: number;
  radius: number;
  collected: boolean;
}

function randRange(
  rng: DeterministicRng,
  min: number,
  max: number
): number {
  return rng.range(min, max);
}

function shuffledLanes(rng: DeterministicRng): number[] {
  return rng.shuffle(
    Array.from({ length: LANE_COUNT }, (_, i) => i)
  );
}

function pickWeightedObstacleType(
  band: DifficultyBand,
  rng: DeterministicRng
): ObstacleType {
  const entries = Object.entries(band.obstacleTypeWeights) as [ObstacleType, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.range(0, total);

  for (const [type, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return type;
  }

  return entries[entries.length - 1][0];
}

function pickWeightedCollectibleType(
  rng: DeterministicRng
): CollectibleType {
  const entries = Object.values(COLLECTIBLE_TYPES);
  const total = entries.reduce((sum, cfg) => sum + cfg.weight, 0);
  let roll = rng.range(0, total);

  for (const cfg of entries) {
    roll -= cfg.weight;
    if (roll <= 0) return cfg.type;
  }

  return entries[entries.length - 1].type;
}

function pickRandomPowerupType(rng: DeterministicRng): PowerupType {
  const types = Object.keys(POWERUP_TYPES) as PowerupType[];
  return rng.pick(types);
}

/**
 * Maybe spawns a new obstacle "slot" (1–2 lanes, never all 3) at the right
 * edge of the world. Returns an empty array when the shared gap hasn't been
 * covered yet.
 */
export function maybeSpawnObstacles(
  obstacles: ObstacleEntity[],
  width: number,
  band: DifficultyBand,
  nextId: () => number,
  rng: DeterministicRng
): ObstacleEntity[] {
  const rightmost = obstacles.reduce((max, o) => Math.max(max, o.x), -Infinity);
  const gap = randRange(rng, band.obstacleGapPxRange[0], band.obstacleGapPxRange[1]);

  if (obstacles.length > 0 && rightmost > width - gap) return [];

  const blockCount =
    band.maxBlockedLanes === 1 ? 1 : rng.next() < 0.5 ? 1 : 2;
  const lanes = shuffledLanes(rng).slice(
    0,
    Math.min(blockCount, LANE_COUNT - 1)
  );

  return lanes.map((lane) => {
    const type = pickWeightedObstacleType(band, rng);
    const cfg = OBSTACLE_TYPES[type];
    return {
      id: nextId(),
      type,
      lane,
      x: width + 24 + randRange(rng, -8, 8),
      width: cfg.width,
      height: cfg.height,
      groundHeight: cfg.groundHeight,
      passed: false,
      hit: false,
    };
  });
}

/** Maybe spawns a single collectible once its own independent gap has been covered. */
export function maybeSpawnCollectible(
  collectibles: CollectibleEntity[],
  width: number,
  band: DifficultyBand,
  nextId: () => number,
  rng: DeterministicRng
): CollectibleEntity | null {
  const rightmost = collectibles.reduce((max, c) => Math.max(max, c.x), -Infinity);
  const gap = randRange(
    rng,
    band.collectibleGapPxRange[0],
    band.collectibleGapPxRange[1]
  );

  if (collectibles.length > 0 && rightmost > width - gap) return null;

  const type = pickWeightedCollectibleType(rng);
  const cfg = COLLECTIBLE_TYPES[type];

  return {
    id: nextId(),
    type,
    lane: rng.int(0, LANE_COUNT - 1),
    x: width + 30,
    radius: cfg.radius,
    collected: false,
  };
}

/** Maybe spawns a single power-up pickup once its own (rarer) gap has been covered. */
export function maybeSpawnPowerup(
  powerups: PowerupEntity[],
  width: number,
  band: DifficultyBand,
  nextId: () => number,
  rng: DeterministicRng
): PowerupEntity | null {
  const rightmost = powerups.reduce((max, p) => Math.max(max, p.x), -Infinity);
  const gap = randRange(
    rng,
    band.powerupGapPxRange[0],
    band.powerupGapPxRange[1]
  );

  if (powerups.length > 0 && rightmost > width - gap) return null;

  const type = pickRandomPowerupType(rng);

  return {
    id: nextId(),
    type,
    lane: rng.int(0, LANE_COUNT - 1),
    x: width + 30,
    radius: 13,
    collected: false,
  };
}
