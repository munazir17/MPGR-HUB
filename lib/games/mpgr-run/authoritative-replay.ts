import {
  BASE_SPEED,
  CHECKPOINT_GRACE_MS,
  CHECKPOINT_INTERVAL_M,
  GRAVITY,
  HIT_INVULNERABILITY_MS,
  JETPACK_FLY_HEIGHT,
  LANE_COUNT,
  MAX_SPEED,
  MAGNET_ATTRACT_MS,
  MAGNET_RANGE_PX,
  PLAYER_SIZE,
  PLAYER_X,
  PX_PER_METER,
  RAMP_DURATION_MS,
  SLIDE_DURATION_MS,
  SPEED_BOOST_MULTIPLIER,
  SPEED_TIERS,
  STARTING_HP,
  type DifficultyBand,
} from "./run-config";
import { resolveDifficulty } from "./difficulty";
import {
  maybeSpawnCollectible,
  maybeSpawnObstacles,
  maybeSpawnPowerup,
  type CollectibleEntity,
  type ObstacleEntity,
  type PowerupEntity,
} from "./spawn-manager";
import { verticalOverlap } from "./run-physics";
import { computeRunScore, type RunResult } from "./run-score";
import { createDeterministicRng } from "./deterministic-rng";
import type { RunInputTrace, RunInputEvent } from "./input-trace";

export const MPGR_RUN_SIMULATION_WIDTH = 960;
export const MPGR_RUN_FIXED_DT_MS = 1000 / 60;

interface ReplayPlayer {
  lane: number;
  playerY: number;
  velocityY: number;
  sliding: boolean;
  slideUntilMs: number;
  hp: number;
  invulnerableUntilMs: number;
}

interface ReplayStats {
  distanceMeters: number;
  durationMs: number;
  coinsCollected: number;
  gemsCollected: number;
  xpOrbsCollected: number;
  keysCollected: number;
  chestsCollected: number;
  powerupsCollected: number;
  obstaclesPassed: number;
  checkpointsReached: number;
  bonusScore: number;
  hitsTaken: number;
  collided: boolean;
  maxSpeedTierReached: number;
}

interface ReplayWorld {
  player: ReplayPlayer;
  speed: number;
  effectiveSpeed: number;
  elapsedMs: number;
  traveledPx: number;
  obstacles: ObstacleEntity[];
  collectibles: CollectibleEntity[];
  powerups: PowerupEntity[];
  activePowerups: Partial<Record<string, number>>;
  stats: ReplayStats;
  nextCheckpointM: number;
  nextId: number;
  gameOver: boolean;
}

function createWorld(): ReplayWorld {
  return {
    player: {
      lane: 1,
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
    activePowerups: {},
    stats: {
      distanceMeters: 0,
      durationMs: 0,
      coinsCollected: 0,
      gemsCollected: 0,
      xpOrbsCollected: 0,
      keysCollected: 0,
      chestsCollected: 0,
      powerupsCollected: 0,
      obstaclesPassed: 0,
      checkpointsReached: 0,
      bonusScore: 0,
      hitsTaken: 0,
      collided: false,
      maxSpeedTierReached: 0,
    },
    nextCheckpointM: CHECKPOINT_INTERVAL_M,
    nextId: 1,
    gameOver: false,
  };
}

function applyInput(world: ReplayWorld, event: RunInputEvent): void {
  const p = world.player;

  if (event.type === "jump") {
    if (world.activePowerups.jetpack) return;
    if (p.playerY <= 0 && !p.sliding) {
      p.velocityY = 850;
    }
    return;
  }

  if (event.type === "slide") {
    if (world.activePowerups.jetpack) return;
    if (p.playerY <= 0) {
      p.sliding = true;
      p.slideUntilMs = world.elapsedMs + SLIDE_DURATION_MS;
    }
    return;
  }

  const nextLane = Math.max(0, Math.min(LANE_COUNT - 1, p.lane + event.dir));
  p.lane = nextLane;
}

function incrementCollectible(world: ReplayWorld, type: CollectibleEntity["type"]): void {
  if (type === "coin") world.stats.coinsCollected++;
  else if (type === "gem") world.stats.gemsCollected++;
  else if (type === "xpOrb") world.stats.xpOrbsCollected++;
  else if (type === "key") world.stats.keysCollected++;
  else if (type === "chest") world.stats.chestsCollected++;
}

function collectItem(world: ReplayWorld, item: CollectibleEntity): void {
  if (item.collected) return;
  item.collected = true;

  incrementCollectible(world, item.type);

  if (world.activePowerups.score2x) {
    const values = { coin: 15, gem: 40, xpOrb: 25, key: 60, chest: 150 };
    world.stats.bonusScore += values[item.type];
  }
}

function collectPowerup(world: ReplayWorld, item: PowerupEntity): void {
  if (item.collected) return;
  item.collected = true;
  const durations: Record<string, number> = {
    magnet: 8000,
    shield: 10000,
    speed: 6000,
    jetpack: 6000,
    score2x: 10000,
    invincibility: 5000,
  };
  world.activePowerups[item.type] = world.elapsedMs + durations[item.type];
  world.stats.powerupsCollected++;
}

function step(world: ReplayWorld, rng: ReturnType<typeof createDeterministicRng>): void {
  const dt = MPGR_RUN_FIXED_DT_MS / 1000;
  const p = world.player;

  world.elapsedMs += MPGR_RUN_FIXED_DT_MS;

  const distanceBefore = world.traveledPx / PX_PER_METER;
  const band: DifficultyBand = resolveDifficulty(distanceBefore);

  const ramp = Math.min(1, world.elapsedMs / RAMP_DURATION_MS);
  world.speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * ramp;

  const speedActive = !!world.activePowerups.speed;
  world.effectiveSpeed = world.speed * (speedActive ? SPEED_BOOST_MULTIPLIER : 1);
  world.traveledPx += world.effectiveSpeed * dt;

  const jetpackActive = !!world.activePowerups.jetpack;

  if (jetpackActive) {
    p.playerY += (JETPACK_FLY_HEIGHT - p.playerY) * Math.min(1, dt * 6);
    p.velocityY = 0;
  } else {
    p.velocityY -= GRAVITY * dt;
    p.playerY += p.velocityY * dt;

    if (p.playerY <= 0) {
      p.playerY = 0;
      p.velocityY = 0;
    }
  }

  if (p.sliding && world.elapsedMs >= p.slideUntilMs) {
    p.sliding = false;
  }

  for (const o of world.obstacles) o.x -= world.effectiveSpeed * dt;
  for (const c of world.collectibles) c.x -= world.effectiveSpeed * dt;
  for (const pu of world.powerups) pu.x -= world.effectiveSpeed * dt;

  world.obstacles = world.obstacles.filter((o) => o.x + o.width > -40);
  world.collectibles = world.collectibles.filter((c) => c.x > -40 && !c.collected);
  world.powerups = world.powerups.filter((pu) => pu.x > -40 && !pu.collected);

  const nextId = () => world.nextId++;

  const obstacles = maybeSpawnObstacles(
    world.obstacles,
    MPGR_RUN_SIMULATION_WIDTH,
    band,
    nextId,
    rng,
  );
  if (obstacles.length) world.obstacles.push(...obstacles);

  const collectible = maybeSpawnCollectible(
    world.collectibles,
    MPGR_RUN_SIMULATION_WIDTH,
    band,
    nextId,
    rng,
  );
  if (collectible) world.collectibles.push(collectible);

  const powerup = maybeSpawnPowerup(
    world.powerups,
    MPGR_RUN_SIMULATION_WIDTH,
    band,
    nextId,
    rng,
  );
  if (powerup) world.powerups.push(powerup);

  for (const [type, expiresAt] of Object.entries(world.activePowerups)) {
    if (expiresAt !== undefined && world.elapsedMs >= expiresAt) {
      delete world.activePowerups[type];
    }
  }

  const playerScreenX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;

  for (const o of world.obstacles) {
    const overlapX =
      playerScreenX + PLAYER_SIZE > o.x &&
      playerScreenX < o.x + o.width;

    const overlapLane = o.lane === p.lane;

    if (!o.hit && overlapX && overlapLane && verticalOverlap(o, p)) {
      o.hit = true;

      if (!o.passed) {
        o.passed = true;
        world.stats.obstaclesPassed++;
      }

      const damageImmune =
        world.elapsedMs < p.invulnerableUntilMs ||
        !!world.activePowerups.shield ||
        !!world.activePowerups.invincibility;

      if (!damageImmune) {
        p.hp--;
        world.stats.hitsTaken++;
        world.stats.collided = true;
        p.invulnerableUntilMs = world.elapsedMs + HIT_INVULNERABILITY_MS;

        if (p.hp <= 0) {
          world.gameOver = true;
        }
      }
    }

    if (!o.passed && o.x + o.width < playerScreenX) {
      o.passed = true;
      world.stats.obstaclesPassed++;
    }
  }

  for (const c of world.collectibles) {
    if (c.collected) continue;

    const dx = Math.abs(c.x - playerScreenX);

    if (world.activePowerups.magnet && dx < MAGNET_RANGE_PX) {
      if (c.magnetizedAtMs === undefined) {
        c.magnetizedAtMs = world.elapsedMs;
      }

      if (world.elapsedMs - c.magnetizedAtMs >= MAGNET_ATTRACT_MS) {
        collectItem(world, c);
      }
    } else if (c.lane === p.lane && dx < c.radius + 15) {
      collectItem(world, c);
    }
  }

  for (const pu of world.powerups) {
    if (pu.collected) continue;

    const dx = Math.abs(pu.x - playerScreenX);

    if (
      pu.lane === p.lane &&
      dx < pu.radius + PLAYER_SIZE / 2
    ) {
      collectPowerup(world, pu);
    }
  }

  const distanceMeters = world.traveledPx / PX_PER_METER;

  while (distanceMeters >= world.nextCheckpointM) {
    world.stats.checkpointsReached++;
    world.nextCheckpointM += CHECKPOINT_INTERVAL_M;
    p.invulnerableUntilMs = Math.max(
      p.invulnerableUntilMs,
      world.elapsedMs + CHECKPOINT_GRACE_MS,
    );
  }

  world.stats.distanceMeters = distanceMeters;
  world.stats.durationMs = world.elapsedMs;
  world.stats.maxSpeedTierReached = Math.floor(
    Math.min(1, world.elapsedMs / RAMP_DURATION_MS) * SPEED_TIERS,
  );
}

function sameNumber(a: number, b: number): boolean {
  return Object.is(a, b) || Math.abs(a - b) <= 1e-9;
}

function sameResult(actual: RunResult, expected: RunResult): boolean {
  const keys: (keyof RunResult)[] = [
    "distanceMeters",
    "durationMs",
    "coinsCollected",
    "gemsCollected",
    "xpOrbsCollected",
    "keysCollected",
    "chestsCollected",
    "powerupsCollected",
    "obstaclesPassed",
    "checkpointsReached",
    "bonusScore",
    "hitsTaken",
    "maxSpeedTierReached",
    "score",
  ];

  for (const key of keys) {
    const av = actual[key];
    const ev = expected[key];

    if (typeof av === "number" && typeof ev === "number") {
      if (!sameNumber(av, ev)) return false;
    } else if (av !== ev) {
      return false;
    }
  }

  return actual.collided === expected.collided;
}

export interface ReplayVerificationResult {
  verified: boolean;
  proofId?: string;
  reason?: string;
}

export function replayAuthoritativeRun(input: {
  seed: string;
  inputTrace: RunInputTrace;
  result: RunResult;
}): ReplayVerificationResult {
  if (!/^[0-9a-fA-F]{64}$/.test(input.seed)) {
    return { verified: false, reason: "Invalid server seed." };
  }

  if (input.inputTrace.version !== 1) {
    return { verified: false, reason: "Unsupported input trace version." };
  }

  if (input.inputTrace.events.length > 4096) {
    return { verified: false, reason: "Input trace is too large." };
  }

  const events = [...input.inputTrace.events];

  let previousMs = -1;

  for (const event of events) {
    if (!Number.isFinite(event.atMs) || event.atMs < 0) {
      return { verified: false, reason: "Invalid input timestamp." };
    }

    if (event.atMs < previousMs) {
      return { verified: false, reason: "Input trace is not ordered." };
    }

    if (
      event.type !== "jump" &&
      event.type !== "slide" &&
      event.type !== "lane"
    ) {
      return { verified: false, reason: "Unsupported input event type." };
    }

    if (
      event.type === "lane" &&
      event.dir !== -1 &&
      event.dir !== 1
    ) {
      return { verified: false, reason: "Invalid lane input." };
    }

    const tick = Math.round(event.atMs / MPGR_RUN_FIXED_DT_MS);
    if (
      tick < 0 ||
      Math.abs(tick * MPGR_RUN_FIXED_DT_MS - event.atMs) > 1e-9
    ) {
      return {
        verified: false,
        reason: "Input timestamp is not aligned to the fixed simulation clock.",
      };
    }

    previousMs = event.atMs;
  }

  if (!Number.isFinite(input.result.durationMs)) {
    return { verified: false, reason: "Invalid run duration." };
  }

  if (!Number.isInteger(input.result.durationMs)) {
    return { verified: false, reason: "Run duration must be an integer number of milliseconds." };
  }

  const ticks = Math.round(input.result.durationMs / MPGR_RUN_FIXED_DT_MS);

  if (
    ticks < 1 ||
    Math.round(ticks * MPGR_RUN_FIXED_DT_MS) !== input.result.durationMs
  ) {
    return { verified: false, reason: "Duration is not aligned to the fixed simulation clock." };
  }

  if (events.some((event) => event.atMs > input.result.durationMs)) {
    return { verified: false, reason: "Input occurs after the submitted run ended." };
  }

  const world = createWorld();
  const rng = createDeterministicRng(input.seed);

  let eventIndex = 0;

  for (let tick = 0; tick < ticks; tick++) {
    const nextTime = world.elapsedMs + MPGR_RUN_FIXED_DT_MS;

    while (
      eventIndex < events.length &&
      events[eventIndex].atMs <= world.elapsedMs
    ) {
      applyInput(world, events[eventIndex]);
      eventIndex++;
    }

    step(world, rng);

    if (world.gameOver) {
      if (tick !== ticks - 1) {
        return { verified: false, reason: "Submitted run continues after game over." };
      }
      break;
    }

    if (nextTime > input.result.durationMs + 0.001) {
      return { verified: false, reason: "Simulation duration mismatch." };
    }
  }

  if (eventIndex < events.length) {
    return { verified: false, reason: "Not all submitted inputs were replayed." };
  }

  if (!world.gameOver) {
    return { verified: false, reason: "Run did not end through an authoritative game-over state." };
  }

  const stats = {
    ...world.stats,
    distanceMeters: world.traveledPx / PX_PER_METER,
    durationMs: Math.round(world.elapsedMs),
  };

  const actual: RunResult = {
    ...stats,
    score: computeRunScore(stats),
  };

  if (!sameResult(actual, input.result)) {
    return { verified: false, reason: "Authoritative replay result does not match the submitted result." };
  }

  return {
    verified: true,
    proofId: `${input.seed.slice(0, 16)}-${Math.round(world.elapsedMs)}-${actual.score}`,
  };
}
