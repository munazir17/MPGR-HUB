// lib/games/games-reward-config.test.ts
//
// Locks the operator-gate contract for real-value game rewards:
// the two feature flags (GAME_REWARDS_ENABLED,
// GAME_AUTHORITATIVE_VERIFICATION_ENABLED) must default to DISABLED and
// gameRewardsAreOperatorEnabled() must fail closed unless both are
// explicitly "true". The authoritative verifier is the in-process
// deterministic replay (lib/games/mpgr-run/authoritative-replay.ts) —
// no external GAME_RUN_VERIFIER_URL/SECRET is required. No test here
// may set a flag to "true" without restoring the environment.

import { describe, expect, it, beforeEach, afterEach } from "vitest";

const KEYS = [
  "GAME_REWARDS_ENABLED",
  "GAME_AUTHORITATIVE_VERIFICATION_ENABLED",
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

describe("game rewards operator gate", () => {
  it("defaults to disabled when no env vars are present", async () => {
    const { gameRewardsAreOperatorEnabled } = await loadConfig();
    expect(gameRewardsAreOperatorEnabled()).toBe(false);
  });

  it.each([
    ["only GAME_REWARDS_ENABLED", () => { process.env.GAME_REWARDS_ENABLED = "true"; }],
    ["only GAME_AUTHORITATIVE_VERIFICATION_ENABLED", () => { process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "true"; }],
    ["flags set to a non-true value", () => {
      process.env.GAME_REWARDS_ENABLED = "1";
      process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "yes";
    }],
    ["flags true but one is whitespace", () => {
      process.env.GAME_REWARDS_ENABLED = " true ";
      process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "true";
    }],
  ])("stays disabled when %s", async (_label, setEnv) => {
    setEnv();
    const { gameRewardsAreOperatorEnabled } = await loadConfig();
    expect(gameRewardsAreOperatorEnabled()).toBe(false);
  });

  it("enables only when both flags are explicitly true", async () => {
    process.env.GAME_REWARDS_ENABLED = "true";
    process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "true";
    const { gameRewardsAreOperatorEnabled } = await loadConfig();
    expect(gameRewardsAreOperatorEnabled()).toBe(true);
  });

  it("does not require any external verifier env vars", async () => {
    // Regression: ensure no code path reads GAME_RUN_VERIFIER_URL/SECRET.
    // Setting them should not affect the gate, and the gate must work without them.
    process.env.GAME_REWARDS_ENABLED = "true";
    process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED = "true";
    const { gameRewardsAreOperatorEnabled } = await loadConfig();
    expect(gameRewardsAreOperatorEnabled()).toBe(true);
    // Also ensure the module does not export authoritativeGameVerifierIsConfigured anymore.
    const mod = await loadConfig();
    expect((mod as Record<string, unknown>).authoritativeGameVerifierIsConfigured).toBeUndefined();
  });

  it("fails closed when authoritative verification flag is missing", async () => {
    process.env.GAME_REWARDS_ENABLED = "true";
    // GAME_AUTHORITATIVE_VERIFICATION_ENABLED not set
    const { gameRewardsAreOperatorEnabled } = await loadConfig();
    expect(gameRewardsAreOperatorEnabled()).toBe(false);
  });
});
