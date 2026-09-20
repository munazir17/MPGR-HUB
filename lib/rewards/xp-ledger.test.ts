import { describe, expect, it } from "vitest";
import { AWARD_CAPPED_GAME_XP_SCRIPT, AWARD_XP_SCRIPT } from "./xp-ledger";

describe("XP ledger Lua scripts", () => {
  it("award script uses redis.call, never the JS redis().call typo", () => {
    expect(AWARD_XP_SCRIPT).toContain('redis.call("SET"');
    expect(AWARD_XP_SCRIPT).toContain('redis.call("INCRBY"');
    expect(AWARD_XP_SCRIPT).toContain('redis.call("ZINCRBY"');
    expect(AWARD_XP_SCRIPT).not.toMatch(/redis\(\)\.call/);
  });

  // Task 6: the event/meta keys used to carry a ~400 day TTL ("EX"), which
  // let one-time events be re-awarded and lost ledger history. Idempotency
  // keys are now permanent; see xp-ledger.durability.test.ts for the
  // executed-Lua behaviour tests.
  it("award script is idempotent via SET NX and never expires ledger keys", () => {
    expect(AWARD_XP_SCRIPT).toContain('"NX"');
    expect(AWARD_XP_SCRIPT).not.toContain('"EX"');
    expect(AWARD_XP_SCRIPT).not.toContain("EXPIRE");
    expect(AWARD_XP_SCRIPT).toContain("if not created then");
    expect(AWARD_XP_SCRIPT).toContain("return 0");
    // Legacy TTL'd keys are made permanent the first time they are replayed.
    expect(AWARD_XP_SCRIPT).toContain('redis.call("PERSIST", KEYS[1])');
    expect(AWARD_XP_SCRIPT).toContain('redis.call("PERSIST", KEYS[6])');
  });

  it("capped game XP script decrements the cap on duplicate or over-cap", () => {
    expect(AWARD_CAPPED_GAME_XP_SCRIPT).toContain('redis.call("INCR"');
    expect(AWARD_CAPPED_GAME_XP_SCRIPT).toContain("return -1");
    expect(AWARD_CAPPED_GAME_XP_SCRIPT).toContain('redis.call("DECR"');
    expect(AWARD_CAPPED_GAME_XP_SCRIPT).not.toMatch(/redis\(\)\.call/);
  });
});
