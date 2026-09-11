import { describe, expect, it } from "vitest";
import { AWARD_CAPPED_GAME_XP_SCRIPT, AWARD_XP_SCRIPT } from "./xp-ledger";

describe("XP ledger Lua scripts", () => {
  it("award script uses redis.call, never the JS redis().call typo", () => {
    expect(AWARD_XP_SCRIPT).toContain('redis.call("SET"');
    expect(AWARD_XP_SCRIPT).toContain('redis.call("INCRBY"');
    expect(AWARD_XP_SCRIPT).toContain('redis.call("ZINCRBY"');
    expect(AWARD_XP_SCRIPT).not.toMatch(/redis\(\)\.call/);
  });

  it("award script is idempotent via SET NX and stores a TTL", () => {
    expect(AWARD_XP_SCRIPT).toContain('"NX"');
    expect(AWARD_XP_SCRIPT).toContain('"EX"');
    expect(AWARD_XP_SCRIPT).toContain("if not created then return 0 end");
  });

  it("capped game XP script decrements the cap on duplicate or over-cap", () => {
    expect(AWARD_CAPPED_GAME_XP_SCRIPT).toContain('redis.call("INCR"');
    expect(AWARD_CAPPED_GAME_XP_SCRIPT).toContain("return -1");
    expect(AWARD_CAPPED_GAME_XP_SCRIPT).toContain('redis.call("DECR"');
    expect(AWARD_CAPPED_GAME_XP_SCRIPT).not.toMatch(/redis\(\)\.call/);
  });
});
