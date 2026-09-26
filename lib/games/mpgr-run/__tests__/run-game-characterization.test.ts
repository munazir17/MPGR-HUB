import { describe, expect, it } from "vitest";
import { freshWorld } from "@/lib/games/mpgr-run/run-world";
import {
  stepSimulation,
  spawnBurst,
  spawnSpriteBurst,
  collectItem,
  collectPowerup,
  buildRunStats,
} from "@/components/features/games/mpgr-run/RunGameSimulation";
import {
  STARTING_HP,
  LANE_COUNT,
  JUMP_VELOCITY,
  SLIDE_DURATION_MS,
  SPEED_BOOST_MULTIPLIER,
  JETPACK_FLY_HEIGHT,
  PX_PER_METER,
  PLAYER_X,
  PLAYER_SIZE,
} from "@/lib/games/mpgr-run/run-config";
import { MPGR_RUN_SIMULATION_WIDTH } from "@/lib/games/mpgr-run/authoritative-replay";
import { clamp } from "@/lib/games/mpgr-run/run-physics";
import { createDeterministicRng } from "@/lib/games/mpgr-run/deterministic-rng";


describe("RunGame Simulation & Extracted Modules Characterization (Task 13)", () => {
  let idCounter = 1;
  const nextId = () => idCounter++;

  it("initializes freshWorld with standard starting conditions", () => {
    const world = freshWorld();
    expect(world.player.hp).toBe(STARTING_HP);
    expect(world.player.lane).toBe(1); // middle lane
    expect(world.player.playerY).toBe(0);
    expect(world.player.velocityY).toBe(0);
    expect(world.player.sliding).toBe(false);
    expect(world.traveledPx).toBe(0);
    expect(world.elapsedMs).toBe(0);
    expect(world.gameOver).toBe(false);
    expect(world.obstacles).toEqual([]);
    expect(world.collectibles).toEqual([]);
    expect(world.powerups).toEqual([]);
  });

  it("clamps lane changes correctly within [0, LANE_COUNT - 1]", () => {
    let lane = 1;
    lane = clamp(lane - 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(0);
    lane = clamp(lane - 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(0);

    lane = clamp(lane + 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(1);
    lane = clamp(lane + 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(2);
    lane = clamp(lane + 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(2);
  });

  describe("stepSimulation physics and input state transitions", () => {
    it("simulates jump arc physics and lands back at ground Y=0", () => {
      const world = freshWorld();
      world.player.velocityY = JUMP_VELOCITY;
      world.player.playerY = 10;

      // Step forward by 0.1s
      stepSimulation(world, 0.1, nextId, null);
      expect(world.player.playerY).toBeGreaterThan(10);
      expect(world.player.velocityY).toBeLessThan(JUMP_VELOCITY);

      // Step forward until gravity brings player back to ground
      for (let i = 0; i < 20; i++) {
        stepSimulation(world, 0.1, nextId, null);
      }
      expect(world.player.playerY).toBe(0);
      expect(world.player.velocityY).toBe(0);
    });

    it("expires sliding state when elapsedMs exceeds slideUntilMs", () => {
      const world = freshWorld();
      world.player.sliding = true;
      world.player.slideUntilMs = 500;

      stepSimulation(world, 0.2, nextId, null); // 200ms elapsed
      expect(world.player.sliding).toBe(true);

      stepSimulation(world, 0.4, nextId, null); // 600ms elapsed
      expect(world.player.sliding).toBe(false);
    });

    it("applies speed boost multiplier when speed power-up is active", () => {
      const world1 = freshWorld();
      const world2 = freshWorld();
      world2.activePowerups.speed = 10000;

      stepSimulation(world1, 0.1, nextId, null);
      stepSimulation(world2, 0.1, nextId, null);

      expect(world2.effectiveSpeed).toBeCloseTo(world1.effectiveSpeed * SPEED_BOOST_MULTIPLIER, 1);
      expect(world2.traveledPx).toBeGreaterThan(world1.traveledPx);
    });

    it("moves player towards JETPACK_FLY_HEIGHT when jetpack power-up is active", () => {
      const world = freshWorld();
      world.activePowerups.jetpack = 5000;
      expect(world.player.playerY).toBe(0);

      stepSimulation(world, 0.5, nextId, null);
      expect(world.player.playerY).toBeGreaterThan(0);
      expect(world.player.playerY).toBeLessThanOrEqual(JETPACK_FLY_HEIGHT);
    });
  });

  describe("Item & Power-up collection and particle bursting", () => {
    it("collects coins, increments stats, and creates particles", () => {
      const world = freshWorld();
      const coin = {
        id: nextId(),
        type: "coin" as const,
        lane: 1,
        x: 100,
        radius: 12,
        collected: false,
      };
      world.collectibles.push(coin);

      collectItem(world, coin, nextId);
      expect(coin.collected).toBe(true);
      expect(world.stats.coins).toBe(1);
      expect(world.particles.length).toBeGreaterThan(0);
      expect(world.spriteBursts.length).toBeGreaterThan(0);
    });

    it("collects powerups, sets active duration, and updates powerup stats", () => {
      const world = freshWorld();
      const powerup = {
        id: nextId(),
        type: "shield" as const,
        lane: 1,
        x: 120,
        radius: 14,
        collected: false,
      };
      world.powerups.push(powerup);

      collectPowerup(world, powerup, nextId);
      expect(powerup.collected).toBe(true);
      expect(world.stats.powerups).toBe(1);
      expect(world.activePowerups.shield).toBeGreaterThan(world.elapsedMs);
    });

    it("clamps particle buffer size to avoid unbounded memory growth", () => {
      const world = freshWorld();
      for (let i = 0; i < 20; i++) {
        spawnBurst(world, 50, 1, 50, "#FFFFFF", 20, nextId);
      }
      expect(world.particles.length).toBeLessThanOrEqual(160);

      for (let i = 0; i < 20; i++) {
        spawnSpriteBurst(world, 50, 1, 50, "burst.png", 300, 30, nextId);
      }
      expect(world.spriteBursts.length).toBeLessThanOrEqual(12);
    });
  });

  describe("Obstacle collision, damage immunity, and game over", () => {
    it("reduces HP on obstacle collision when not immune and ends game at 0 HP", () => {
      const world = freshWorld();
      world.player.hp = 1;
      const playerScreenX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;

      world.obstacles.push({
        id: nextId(),
        type: "barrier",
        lane: 1,
        x: playerScreenX + 10,
        width: 30,
        height: 40,
        groundHeight: 0,
        hit: false,
        passed: false,
      });

      stepSimulation(world, 0.001, nextId, null);
      expect(world.player.hp).toBe(0);
      expect(world.gameOver).toBe(true);
      expect(world.stats.hits).toBe(1);
    });

    it("shields player from obstacle damage when shield powerup is active", () => {
      const world = freshWorld();
      world.player.hp = STARTING_HP;
      world.activePowerups.shield = 10000;
      const playerScreenX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;

      world.obstacles.push({
        id: nextId(),
        type: "barrier",
        lane: 1,
        x: playerScreenX + 10,
        width: 30,
        height: 40,
        groundHeight: 0,
        hit: false,
        passed: false,
      });

      stepSimulation(world, 0.001, nextId, null);
      expect(world.player.hp).toBe(STARTING_HP);
      expect(world.gameOver).toBe(false);
      expect(world.stats.hits).toBe(0);
    });
  });

  describe("Deterministic RNG spawning in stepSimulation", () => {
    it("spawns entities deterministically using DeterministicRng", () => {
      const rng1 = createDeterministicRng(42);
      const rng2 = createDeterministicRng(42);
      const world1 = freshWorld();
      const world2 = freshWorld();

      // Run 60 ticks on both worlds with identical RNG seed
      for (let i = 0; i < 60; i++) {
        stepSimulation(world1, 0.05, nextId, rng1);
        stepSimulation(world2, 0.05, nextId, rng2);
      }

      expect(world1.obstacles.length).toBe(world2.obstacles.length);
      expect(world1.collectibles.length).toBe(world2.collectibles.length);
      expect(world1.traveledPx).toBe(world2.traveledPx);
    });
  });

  describe("buildRunStats", () => {
    it("builds complete RunStats structure consistent with world progress", () => {
      const world = freshWorld();
      world.traveledPx = 2500;
      world.elapsedMs = 4000;
      world.stats.coins = 15;
      world.stats.gems = 2;
      world.stats.checkpoints = 1;

      const stats = buildRunStats(world);
      expect(stats.distanceMeters).toBe(2500 / PX_PER_METER);
      expect(stats.coinsCollected).toBe(15);
      expect(stats.gemsCollected).toBe(2);
      expect(stats.checkpointsReached).toBe(1);
      expect(stats.durationMs).toBeGreaterThan(0);
    });
  });
});
