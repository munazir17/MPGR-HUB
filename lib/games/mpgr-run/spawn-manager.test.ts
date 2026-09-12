import { describe, expect, it } from "vitest";
import { createDeterministicRng } from "./deterministic-rng";
import { resolveDifficulty } from "./difficulty";
import {
  maybeSpawnCollectible,
  maybeSpawnObstacles,
  maybeSpawnPowerup,
  type CollectibleEntity,
  type ObstacleEntity,
  type PowerupEntity,
} from "./spawn-manager";

function idFactory() {
  let id = 1;
  return () => id++;
}

describe("MPGR Run spawn manager", () => {
  it("produces identical obstacle spawns for the same seed", () => {
    const band = resolveDifficulty(0);

    const obstaclesA: ObstacleEntity[] = [];
    const obstaclesB: ObstacleEntity[] = [];

    const rngA = createDeterministicRng(12345);
    const rngB = createDeterministicRng(12345);

    const idsA = idFactory();
    const idsB = idFactory();

    const resultsA = [];
    const resultsB = [];

    for (let i = 0; i < 20; i += 1) {
      const spawnedA = maybeSpawnObstacles(
        obstaclesA,
        800,
        band,
        idsA,
        rngA
      );

      const spawnedB = maybeSpawnObstacles(
        obstaclesB,
        800,
        band,
        idsB,
        rngB
      );

      resultsA.push(spawnedA);
      resultsB.push(spawnedB);

      obstaclesA.push(...spawnedA);
      obstaclesB.push(...spawnedB);

      // Simulate world movement enough to allow future slots.
      for (const obstacle of obstaclesA) obstacle.x -= 700;
      for (const obstacle of obstaclesB) obstacle.x -= 700;
    }

    expect(resultsA).toEqual(resultsB);
  });

  it("does not generate three blocked lanes", () => {
    const band = resolveDifficulty(2000);
    const rng = createDeterministicRng(987654321);
    const obstacles: ObstacleEntity[] = [];
    const nextId = idFactory();

    for (let i = 0; i < 100; i += 1) {
      const spawned = maybeSpawnObstacles(
        obstacles,
        800,
        band,
        nextId,
        rng
      );

      expect(spawned.length).toBeLessThanOrEqual(band.maxBlockedLanes);
      expect(new Set(spawned.map((obstacle) => obstacle.lane)).size)
        .toBe(spawned.length);

      obstacles.push(...spawned);

      for (const obstacle of obstacles) obstacle.x -= 700;
    }
  });

  it("keeps obstacle types valid for the resolved difficulty band", () => {
    const band = resolveDifficulty(2000);
    const rng = createDeterministicRng(24680);
    const obstacles: ObstacleEntity[] = [];
    const nextId = idFactory();

    const allowedTypes = new Set(
      Object.keys(band.obstacleTypeWeights)
    );

    for (let i = 0; i < 100; i += 1) {
      const spawned = maybeSpawnObstacles(
        obstacles,
        800,
        band,
        nextId,
        rng
      );

      for (const obstacle of spawned) {
        expect(allowedTypes.has(obstacle.type)).toBe(true);
        expect(obstacle.lane).toBeGreaterThanOrEqual(0);
        expect(obstacle.lane).toBeLessThan(3);
        expect(obstacle.passed).toBe(false);
        expect(obstacle.hit).toBe(false);
      }

      obstacles.push(...spawned);

      for (const obstacle of obstacles) obstacle.x -= 700;
    }
  });

  it("produces deterministic collectible spawns", () => {
    const band = resolveDifficulty(1000);

    const collectiblesA: CollectibleEntity[] = [];
    const collectiblesB: CollectibleEntity[] = [];

    const rngA = createDeterministicRng(111);
    const rngB = createDeterministicRng(111);

    const idsA = idFactory();
    const idsB = idFactory();

    const resultsA = [];
    const resultsB = [];

    for (let i = 0; i < 30; i += 1) {
      const a = maybeSpawnCollectible(
        collectiblesA,
        800,
        band,
        idsA,
        rngA
      );

      const b = maybeSpawnCollectible(
        collectiblesB,
        800,
        band,
        idsB,
        rngB
      );

      resultsA.push(a);
      resultsB.push(b);

      if (a) collectiblesA.push(a);
      if (b) collectiblesB.push(b);

      for (const collectible of collectiblesA) collectible.x -= 700;
      for (const collectible of collectiblesB) collectible.x -= 700;
    }

    expect(resultsA).toEqual(resultsB);
  });

  it("produces deterministic power-up spawns", () => {
    const band = resolveDifficulty(2000);

    const powerupsA: PowerupEntity[] = [];
    const powerupsB: PowerupEntity[] = [];

    const rngA = createDeterministicRng(222);
    const rngB = createDeterministicRng(222);

    const idsA = idFactory();
    const idsB = idFactory();

    const resultsA = [];
    const resultsB = [];

    for (let i = 0; i < 30; i += 1) {
      const a = maybeSpawnPowerup(
        powerupsA,
        800,
        band,
        idsA,
        rngA
      );

      const b = maybeSpawnPowerup(
        powerupsB,
        800,
        band,
        idsB,
        rngB
      );

      resultsA.push(a);
      resultsB.push(b);

      if (a) powerupsA.push(a);
      if (b) powerupsB.push(b);

      for (const powerup of powerupsA) powerup.x -= 1200;
      for (const powerup of powerupsB) powerup.x -= 1200;
    }

    expect(resultsA).toEqual(resultsB);
  });

  it("keeps collectible and power-up lanes within bounds", () => {
    const band = resolveDifficulty(1500);

    const collectibles: CollectibleEntity[] = [];
    const powerups: PowerupEntity[] = [];

    const rng = createDeterministicRng(333);
    const collectibleIds = idFactory();
    const powerupIds = idFactory();

    for (let i = 0; i < 100; i += 1) {
      const collectible = maybeSpawnCollectible(
        collectibles,
        800,
        band,
        collectibleIds,
        rng
      );

      const powerup = maybeSpawnPowerup(
        powerups,
        800,
        band,
        powerupIds,
        rng
      );

      if (collectible) {
        expect(collectible.lane).toBeGreaterThanOrEqual(0);
        expect(collectible.lane).toBeLessThan(3);
        expect(collectible.collected).toBe(false);
      }

      if (powerup) {
        expect(powerup.lane).toBeGreaterThanOrEqual(0);
        expect(powerup.lane).toBeLessThan(3);
        expect(powerup.collected).toBe(false);
      }

      if (collectible) collectibles.push(collectible);
      if (powerup) powerups.push(powerup);

      for (const item of collectibles) item.x -= 700;
      for (const item of powerups) item.x -= 1200;
    }
  });

  it("can produce a different sequence from a different seed", () => {
    const band = resolveDifficulty(0);

    const rngA = createDeterministicRng(1);
    const rngB = createDeterministicRng(2);

    const a = maybeSpawnObstacles(
      [],
      800,
      band,
      idFactory(),
      rngA
    );

    const b = maybeSpawnObstacles(
      [],
      800,
      band,
      idFactory(),
      rngB
    );

    expect(a).not.toEqual(b);
  });
});
