// lib/games/games-reward-config.test.ts
//
// Task 7 — locks the operator-gate contract for real-value game rewards:
// the two feature flags (GAME_REWARDS_ENABLED,
// GAME_AUTHORITATIVE_VERIFICATION_ENABLED) must default to DISABLED and
// gameRewardsAreOperatorEnabled() must fail closed unless both are
// explicitly "true" AND the verifier endpoint is configured. No test
// here may set a flag to "true" without restoring the environment.

import { describe, expect, it, beforeEach, afterEach } from "vitest";

const KEYS = [
  "GAME_REWARDS_ENABLED",
  "GAME_AUTHORITATIVE_VERIFICATION_ENABLED",
  "GAME_RUN_VERIFIER_URL",
  "GAME_RUN_VERIFIER_SECRET",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function loadConfig() {
  // The gate reads process.env at call time, so a plain import is enough.
  return import("./games-reward-config");
}

describe("game rewards operator gate (Task 7)", () => {
  it("defaults to disabled when no env vars are present", async () => {
    const { gameRewardsAreOperatorEnabled, authoritativeGameVerifierIsConfigured } = await loadConfig();
    expect(authoritativeGameVerifierIsConfigured()).toBe(false);
    expect(gameRewardsAreOperatorEnabled()).toBe(false);
  });

  it.each([
    ["only GAME_REWARDS_ENABLED", () => { process.env.GAME_REWARDS_ENABLED = "true"; }],
    ["only GAME_AUTHORITATIVE_VERIFICATION_ENABLED", () => { process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "true"; }],
    ["both flags but no verifier endpoint", () => {
      process.env.GAME_REWARDS_ENABLED = "true";
      process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "true";
    }],
    ["flags true but only the verifier URL (no secret)", () => {
      process.env.GAME_REWARDS_ENABLED = "true";
      process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "true";
      process.env.GAME_RUN_VERIFIER_URL = "https://verifier.example";
    }],
    ["flags set to a non-true value", () => {
      process.env.GAME_REWARDS_ENABLED = "1";
      process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "yes";
    }],
  ])("stays disabled when %s", async (_label, setEnv) => {
    setEnv();
    const { gameRewardsAreOperatorEnabled } = await loadConfig();
    expect(gameRewardsAreOperatorEnabled()).toBe(false);
  });

  it("enables only when both flags are true AND the verifier URL+secret are configured", async () => {
    process.env.GAME_REWARDS_ENABLED = "true";
    process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "true";
    process.env.GAME_RUN_VERIFIER_URL = "https://verifier.example";
    process.env.GAME_RUN_VERIFIER_SECRET = "secret";
    const { gameRewardsAreOperatorEnabled } = await loadConfig();
    expect(gameRewardsAreOperatorEnabled()).toBe(true);
  });
});
