// components/features/games/mpgr-run/RunGameSimulation.ts
import { MPGR_RUN_SIMULATION_WIDTH } from "@/lib/games/mpgr-run/authoritative-replay";
import { snapDurationToSimulationTicks } from "@/lib/games/mpgr-run/input-trace";
import type { RunStats } from "@/lib/games/mpgr-run/run-score";
import { resolveDifficulty } from "@/lib/games/mpgr-run/difficulty";
import {
  maybeSpawnObstacles,
  maybeSpawnCollectible,
  maybeSpawnPowerup,
  type CollectibleEntity,
  type PowerupEntity,
} from "@/lib/games/mpgr-run/spawn-manager";
import { getRunAudioHooks } from "@/lib/games/mpgr-run/audio-hooks";
import {
  EFFECT_SPRITES,
} from "@/lib/games/mpgr-run/run-assets";
import {
  LANE_GAP_PX,
  PLAYER_X,
  PLAYER_SIZE,
  GRAVITY,
  BASE_SPEED,
  MAX_SPEED,
  RAMP_DURATION_MS,
  SPEED_TIERS,
  PX_PER_METER,
  HIT_INVULNERABILITY_MS,
  CHECKPOINT_INTERVAL_M,
  CHECKPOINT_GRACE_MS,
  JETPACK_FLY_HEIGHT,
  MAGNET_RANGE_PX,
  MAGNET_ATTRACT_MS,
  SPEED_BOOST_MULTIPLIER,
  COLLECTIBLE_TYPES,
  POWERUP_TYPES,
  type PowerupType,
} from "@/lib/games/mpgr-run/run-config";
import { laneBaselineScreenY, verticalOverlap } from "@/lib/games/mpgr-run/run-physics";
import type { World } from "@/lib/games/mpgr-run/run-world";
import type { DeterministicRng } from "@/lib/games/mpgr-run/deterministic-rng";

export function spawnBurst(
  world: World,
  x: number,
  y: number,
  color: string,
  count: number,
  nextId: () => number
) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 140;
    world.particles.push({
      id: nextId(),
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 350 + Math.random() * 300,
      maxLife: 650,
      color,
      size: 2 + Math.random() * 3,
    });
  }
  if (world.particles.length > 160) {
    world.particles.splice(0, world.particles.length - 160);
  }
}

export function spawnSpriteBurst(
  world: World,
  x: number,
  y: number,
  sprite: string,
  durationMs: number,
  maxSize: number,
  nextId: () => number
) {
  world.spriteBursts.push({
    id: nextId(),
    x,
    y,
    sprite,
    startMs: world.elapsedMs,
    durationMs,
    maxSize,
  });
  if (world.spriteBursts.length > 12) {
    world.spriteBursts.splice(0, world.spriteBursts.length - 12);
  }
}

export function collectItem(
  world: World,
  c: CollectibleEntity,
  height: number,
  nextId: () => number
) {
  c.collected = true;
  const cfg = COLLECTIBLE_TYPES[c.type];
  const hooks = getRunAudioHooks();
  switch (c.type) {
    case "coin":
      world.stats.coins += 1;
      hooks.onCoinPickup();
      break;
    case "gem":
      world.stats.gems += 1;
      hooks.onGemPickup();
      break;
    case "xpOrb":
      world.stats.xpOrbs += 1;
      hooks.onCoinPickup();
      break;
    case "key":
      world.stats.keys += 1;
      hooks.onCoinPickup();
      break;
    case "chest":
      world.stats.chests += 1;
      hooks.onCoinPickup();
      break;
  }
  if (world.activePowerups.score2x) world.bonusScore += cfg.scoreValue;
  const cx = c.x;
  const cy = laneBaselineScreenY(height, c.lane) - 14;
  spawnBurst(world, cx, cy, cfg.color, c.type === "chest" ? 16 : 6, nextId);
  if (c.type === "coin" || c.type === "xpOrb" || c.type === "key") {
    spawnSpriteBurst(world, cx, cy, EFFECT_SPRITES.coinBurst, 380, c.radius * 5, nextId);
  } else if (c.type === "gem") {
    spawnSpriteBurst(world, cx, cy, EFFECT_SPRITES.gemBurst, 420, c.radius * 5.5, nextId);
  }
}

export function collectPowerup(
  world: World,
  pu: PowerupEntity,
  height: number,
  nextId: () => number
) {
  pu.collected = true;
  const cfg = POWERUP_TYPES[pu.type];
  world.activePowerups[pu.type] = world.elapsedMs + cfg.durationMs;
  world.stats.powerups += 1;
  getRunAudioHooks().onPowerupPickup(pu.type);
  spawnBurst(world, pu.x, laneBaselineScreenY(height, pu.lane) - 20, cfg.color, 10, nextId);
}

export function buildRunStats(world: World): RunStats {
  return {
    distanceMeters: world.traveledPx / PX_PER_METER,
    durationMs: snapDurationToSimulationTicks(world.elapsedMs),
    coinsCollected: world.stats.coins,
    gemsCollected: world.stats.gems,
    xpOrbsCollected: world.stats.xpOrbs,
    keysCollected: world.stats.keys,
    chestsCollected: world.stats.chests,
    powerupsCollected: world.stats.powerups,
    obstaclesPassed: world.stats.obstaclesPassed,
    checkpointsReached: world.stats.checkpoints,
    bonusScore: world.bonusScore,
    hitsTaken: world.stats.hits,
    collided: world.stats.hits > 0,
    maxSpeedTierReached: Math.floor(Math.min(1, world.elapsedMs / RAMP_DURATION_MS) * SPEED_TIERS),
  };
}

export function stepSimulation(
  world: World,
  dt: number,
  canvasHeight: number,
  nextId: () => number,
  rng: DeterministicRng | null
) {
  const playerScreenX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;
  const p = world.player;
  const hooks = getRunAudioHooks();

  world.elapsedMs += dt * 1000;

  const distanceMetersSoFar = world.traveledPx / PX_PER_METER;
  const band = resolveDifficulty(distanceMetersSoFar);

  const rampProgress = Math.min(1, world.elapsedMs / RAMP_DURATION_MS);
  world.speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * rampProgress;
  const speedActive = !!world.activePowerups.speed;
  world.effectiveSpeed = world.speed * (speedActive ? SPEED_BOOST_MULTIPLIER : 1);
  world.traveledPx += world.effectiveSpeed * dt;

  // Vertical physics.
  const jetpackActive = !!world.activePowerups.jetpack;
  if (jetpackActive) {
    p.playerY += (JETPACK_FLY_HEIGHT - p.playerY) * Math.min(1, dt * 6);
    p.velocityY = 0;
  } else {
    const wasGrounded = p.playerY <= 0;
    p.velocityY -= GRAVITY * dt;
    p.playerY += p.velocityY * dt;
    if (p.playerY <= 0) {
      p.playerY = 0;
      p.velocityY = 0;
      if (!wasGrounded) hooks.onLand();
    }
  }
  if (p.sliding && world.elapsedMs >= p.slideUntilMs) p.sliding = false;

  // Smooth lane transition (visual only — collision uses the logical lane instantly).
  const targetOffset = (p.lane - 1) * LANE_GAP_PX;
  p.laneOffset += (targetOffset - p.laneOffset) * Math.min(1, dt * 10);

  // Scroll entities.
  for (const o of world.obstacles) o.x -= world.effectiveSpeed * dt;
  for (const c of world.collectibles) c.x -= world.effectiveSpeed * dt;
  for (const pu of world.powerups) pu.x -= world.effectiveSpeed * dt;
  world.obstacles = world.obstacles.filter((o) => o.x + o.width > -40);
  world.collectibles = world.collectibles.filter((c) => c.x > -40 && !c.collected);
  world.powerups = world.powerups.filter((pu) => pu.x > -40 && !pu.collected);

  // Particles.
  for (const part of world.particles) {
    part.life -= dt * 1000;
    part.x -= world.effectiveSpeed * dt * 0.5 + part.vx * dt;
    part.y += part.vy * dt;
  }
  world.particles = world.particles.filter((part) => part.life > 0);

  // Sprite bursts (real hit/pickup artwork) — scroll with the world and expire on a fixed timer.
  for (const burst of world.spriteBursts) {
    burst.x -= world.effectiveSpeed * dt * 0.5;
  }
  world.spriteBursts = world.spriteBursts.filter((burst) => world.elapsedMs - burst.startMs < burst.durationMs);

  world.screenShake = Math.max(0, world.screenShake - dt * 40);

  // Spawn.
  const newObstacles = rng ? maybeSpawnObstacles(world.obstacles, MPGR_RUN_SIMULATION_WIDTH, band, nextId, rng) : [];
  if (newObstacles.length) world.obstacles.push(...newObstacles);
  const newCollectible = rng ? maybeSpawnCollectible(world.collectibles, MPGR_RUN_SIMULATION_WIDTH, band, nextId, rng) : null;
  if (newCollectible) world.collectibles.push(newCollectible);
  const newPowerup = rng ? maybeSpawnPowerup(world.powerups, MPGR_RUN_SIMULATION_WIDTH, band, nextId, rng) : null;
  if (newPowerup) world.powerups.push(newPowerup);

  // Expire power-ups.
  (Object.keys(world.activePowerups) as PowerupType[]).forEach((key) => {
    const exp = world.activePowerups[key];
    if (exp !== undefined && world.elapsedMs >= exp) {
      delete world.activePowerups[key];
      hooks.onPowerupExpire(key);
    }
  });

  // Obstacle collisions.
  const damageImmune =
    world.elapsedMs < p.invulnerableUntilMs || !!world.activePowerups.shield || !!world.activePowerups.invincibility;

  for (const o of world.obstacles) {
    const overlapX = playerScreenX + PLAYER_SIZE > o.x && playerScreenX < o.x + o.width;
    const overlapLane = o.lane === p.lane;

    if (!o.hit && overlapX && overlapLane && verticalOverlap(o, p)) {
      o.hit = true;
      if (!o.passed) {
        o.passed = true;
        world.stats.obstaclesPassed += 1;
      }
      if (damageImmune) {
        spawnBurst(world, o.x, laneBaselineScreenY(canvasHeight, o.lane) - o.groundHeight - o.height / 2, "#60A5FA", 8, nextId);
      } else {
        p.hp -= 1;
        world.stats.hits += 1;
        p.invulnerableUntilMs = world.elapsedMs + HIT_INVULNERABILITY_MS;
        world.screenShake = 14;
        world.hitFlashUntilMs = world.elapsedMs + 220;
        const hitCx = playerScreenX + PLAYER_SIZE / 2;
        const hitCy = laneBaselineScreenY(canvasHeight, p.lane) - p.playerY - PLAYER_SIZE / 2;
        spawnBurst(world, playerScreenX, hitCy, "#F87171", 14, nextId);
        spawnSpriteBurst(world, hitCx, hitCy, EFFECT_SPRITES.hit, 480, PLAYER_SIZE * 3.2, nextId);
        hooks.onHit();
        if (p.hp <= 0) world.gameOver = true;
      }
    }

    if (!o.passed && o.x + o.width < playerScreenX) {
      o.passed = true;
      world.stats.obstaclesPassed += 1;
    }
  }

  // Collectible pickup + magnet.
  const magnetActive = !!world.activePowerups.magnet;
  for (const c of world.collectibles) {
    if (c.collected) continue;
    const sameLane = c.lane === p.lane;
    const dx = Math.abs(c.x - playerScreenX);

    if (magnetActive && dx < MAGNET_RANGE_PX) {
      if (c.magnetizedAtMs === undefined) c.magnetizedAtMs = world.elapsedMs;
      if (world.elapsedMs - c.magnetizedAtMs >= MAGNET_ATTRACT_MS) {
        collectItem(world, c, canvasHeight, nextId);
      }
    } else if (sameLane && dx < c.radius + 15) {
      collectItem(world, c, canvasHeight, nextId);
    }
  }

  // Power-up pickup.
  for (const pu of world.powerups) {
    if (pu.collected) continue;
    const sameLane = pu.lane === p.lane;
    const dx = Math.abs(pu.x - playerScreenX);
    if (sameLane && dx < pu.radius + PLAYER_SIZE / 2) {
      collectPowerup(world, pu, canvasHeight, nextId);
    }
  }

  // Checkpoints.
  const distanceMeters = world.traveledPx / PX_PER_METER;
  while (distanceMeters >= world.nextCheckpointM) {
    world.stats.checkpoints += 1;
    world.nextCheckpointM += CHECKPOINT_INTERVAL_M;
    p.invulnerableUntilMs = Math.max(p.invulnerableUntilMs, world.elapsedMs + CHECKPOINT_GRACE_MS);
    world.checkpointFlashUntilMs = world.elapsedMs + 1400;
    hooks.onCheckpoint();
  }
}
