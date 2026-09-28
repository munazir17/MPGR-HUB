import { describe, expect, it } from "vitest";
import { buildRunStats, stepSimulation } from "@/components/features/games/mpgr-run/RunGameSimulation";
import { freshWorld } from "./run-world";
import { createDeterministicRng } from "./deterministic-rng";
import { replayAuthoritativeRun } from "./authoritative-replay";
import { finalizeRun } from "./run-score";
import { createRunInputTrace } from "./input-trace";
import { JUMP_VELOCITY, SLIDE_DURATION_MS } from "./run-config";

describe("client simulation agrees with unchanged authoritative replay", () => {
  for (const number of [1, 2, 7, 13, 29, 43, 71, 99]) {
    for (const controls of [false, true]) {
      it(`seed ${number}, controls ${controls}: exact collectible/reward/spawn parity`, () => {
        const seed = number.toString(16).padStart(64, "0");
        const world = freshWorld(), rng = createDeterministicRng(seed), trace = createRunInputTrace();
        let id = 1;
        for (let tick = 0; tick < 60 * 1800 && !world.gameOver; tick++) {
          const p = world.player;
          if (controls && tick < 1800) {
            if (tick % 113 === 0) {
              const dir = p.lane === 2 ? -1 : 1;
              trace.events.push({type:"lane", atMs: world.elapsedMs, dir});
              p.lane += dir;
            }
            if (tick % 173 === 0 && p.playerY <= 0 && !p.sliding && !world.activePowerups.jetpack) {
              trace.events.push({type:"jump", atMs:world.elapsedMs}); p.velocityY = JUMP_VELOCITY;
            }
            if (tick % 197 === 0 && p.playerY <= 0 && !world.activePowerups.jetpack) {
              trace.events.push({type:"slide", atMs:world.elapsedMs}); p.sliding = true; p.slideUntilMs = world.elapsedMs + SLIDE_DURATION_MS;
            }
          }
          stepSimulation(world, 1 / 60, () => id++, rng);
        }
        expect(world.gameOver).toBe(true);
        const result = finalizeRun(buildRunStats(world));
        const replay = replayAuthoritativeRun({seed, inputTrace:trace, result});
        expect(replay.verified, JSON.stringify(replay)).toBe(true);
        expect(replay.computedResult).toEqual(result);
      });
    }
  }
});
