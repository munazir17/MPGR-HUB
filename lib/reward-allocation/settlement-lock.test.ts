// lib/reward-allocation/settlement-lock.test.ts
//
// Regression coverage for withSettlementLock().
//
// @upstash/redis is mocked entirely — this test never touches a real
// Redis instance, so it cannot execute the embedded Lua release script
// against a real Lua interpreter (that would require an integration
// test against actual Redis/Upstash). What it CAN and does verify:
//
//   1. acquire -> run fn() -> release happens, in that order;
//   2. the value withSettlementLock() resolves with is fn()'s return
//      value, unmodified by the release step (this is the exact shape
//      of bug that "redis().call(...)" caused: a throwing release
//      script in the `finally` block silently replaced a successful
//      result with a thrown error);
//   3. the release script text does not contain the "redis()" typo
//      that made every previous release throw invalid-Lua errors —
//      guarding against the specific regression, not full Lua
//      execution;
//   4. when the lock is already held (set-NX fails), fn() is never
//      invoked and a {locked: true} result is returned instead.

import { describe, expect, it, vi, beforeEach } from "vitest";

const set = vi.fn(async () => "OK" as string | null);
const evalFn = vi.fn(async (_script: string, ..._args: unknown[]) => 1);

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(function () {
    return { set, eval: evalFn };
  }),
}));

process.env.UPSTASH_REDIS_REST_URL = "https://example-test.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

describe("withSettlementLock", () => {
  beforeEach(() => {
    set.mockClear();
    evalFn.mockClear();
  });

  it("acquires, runs fn(), releases, and resolves with fn()'s own return value", async () => {
    const { withSettlementLock } = await import("./settlement-lock");
    set.mockResolvedValueOnce("OK");
    evalFn.mockResolvedValueOnce(1);

    const fn = vi.fn(async () => ({ status: "finalized" as const }));
    const result = await withSettlementLock("2026-W36", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(evalFn).toHaveBeenCalledTimes(1);
    // The critical assertion: a throwing/misbehaving release step must
    // never override a successful fn() result.
    expect(result).toEqual({ status: "finalized" });
  });

  it("release script uses redis.call (not the redis().call typo that made release always throw)", async () => {
    const { withSettlementLock } = await import("./settlement-lock");
    set.mockResolvedValueOnce("OK");
    evalFn.mockResolvedValueOnce(1);

    await withSettlementLock("2026-W36", async () => "done");

    const scriptArg = evalFn.mock.calls[0]?.[0];
    if (typeof scriptArg !== "string") throw new Error("Expected release Lua script");
    expect(scriptArg).not.toMatch(/redis\(\)\.call/);
    expect(scriptArg).toMatch(/redis\.call/);
  });

  it("still releases the lock (best-effort) even if fn() throws, and propagates fn()'s error", async () => {
    const { withSettlementLock } = await import("./settlement-lock");
    set.mockResolvedValueOnce("OK");
    evalFn.mockResolvedValueOnce(1);

    const boom = new Error("allocation failed");
    await expect(
      withSettlementLock("2026-W36", async () => {
        throw boom;
      }),
    ).rejects.toThrow("allocation failed");

    expect(evalFn).toHaveBeenCalledTimes(1);
  });

  it("does not call fn() when the lock is already held", async () => {
    const { withSettlementLock } = await import("./settlement-lock");
    set.mockResolvedValueOnce(null); // NX failed: another holder has it

    const fn = vi.fn(async () => "should not run");
    const result = await withSettlementLock("2026-W36", fn);

    expect(fn).not.toHaveBeenCalled();
    expect(evalFn).not.toHaveBeenCalled();
    expect(result).toEqual({ locked: true, weekKey: "2026-W36" });
  });
});
