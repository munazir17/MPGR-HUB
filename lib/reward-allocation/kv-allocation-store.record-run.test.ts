// lib/reward-allocation/kv-allocation-store.record-run.test.ts
//
// Task 7 — regression coverage for the attestation parameters added to
// recordValidatedRun (V2): the store must pass the verification version
// and proof id into the atomic Lua script (ARGV[6]/ARGV[7]), default to
// empty strings when absent (never clearing a stored attestation — the
// upgrade-only guard lives in the script), reject malformed attestation
// values, and keep the existing validation for score/points/threshold.
//
// @upstash/redis is mocked entirely (same pattern as
// server-session.security.test.ts) — this exercises the store's own
// argument construction and validation, not a real Redis server. The
// script's upgrade-only semantics are asserted structurally (the script
// must only write the fields when the argument is non-empty) because no
// Lua interpreter is available in the test environment.

import { describe, expect, it, vi, beforeEach } from "vitest";

const evalFn = vi.fn(async () => JSON.stringify({
  wallet: "0x2222222222222222222222222222222222222222",
  weekKey: "2026-W37",
  validRunCount: 1,
  bestScore: 10,
  seasonPointsEarnedThisWeek: 0,
  lastRunAt: "2026-09-01T00:00:00.000Z",
  eligibilityStatus: "pending",
  allocationStatus: "none",
  verificationVersion: "authoritative-v1",
  authoritativeProofId: "proof-123",
}));
const saddFn = vi.fn(async () => 1);

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(function () {
    return {
      eval: evalFn,
      sadd: saddFn,
    };
  }),
}));

process.env.UPSTASH_REDIS_REST_URL = "https://example-test.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

const WALLET = "0x2222222222222222222222222222222222222222" as `0x${string}`;

async function loadStore() {
  const { kvAllocationStore } = await import("./kv-allocation-store");
  return kvAllocationStore;
}

describe("kvAllocationStore.recordValidatedRun — attestation (Task 7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes verificationVersion and authoritativeProofId as ARGV[6]/ARGV[7]", async () => {
    const store = await loadStore();
    await store.recordValidatedRun(
      WALLET,
      "2026-W37",
      123.5,
      7,
      "2026-09-01T00:00:00.000Z",
      5,
      "authoritative-v1",
      "proof-123",
    );

    expect(evalFn).toHaveBeenCalledTimes(1);
    // JS args[] is 0-based; Lua ARGV[n] === args[n-1]:
    // ARGV[1]=base record, ARGV[2]=score, ARGV[3]=seasonPoints,
    // ARGV[4]=lastRunAt, ARGV[5]=minRuns, ARGV[6]=verificationVersion,
    // ARGV[7]=authoritativeProofId.
    const [_script, keys, args] = evalFn.mock.calls[0] as unknown as [string, string[], string[]];
    expect(keys[0]).toBe("mpgrhub:games:playerweek:2026-W37:0x2222222222222222222222222222222222222222");
    expect(args[1]).toBe("123.5");
    expect(args[2]).toBe("7");
    expect(args[4]).toBe("5");
    expect(args[5]).toBe("authoritative-v1");
    expect(args[6]).toBe("proof-123");
  });

  it("defaults to empty ARGV[6]/ARGV[7] when no attestation is supplied (never clears a stored one)", async () => {
    const store = await loadStore();
    await store.recordValidatedRun(WALLET, "2026-W37", 10, 0, "2026-09-01T00:00:00.000Z", 5);

    const [script, _keys, args] = evalFn.mock.calls[0] as unknown as [string, string[], string[]];
    // ARGV[6]/ARGV[7] (attestation) are args[5]/args[6] in the 0-based JS array.
    expect(args[5]).toBe("");
    expect(args[6]).toBe("");
    // The script must only assign the fields for non-empty arguments —
    // that is what makes an empty attestation unable to downgrade a
    // record that a verified run already attested.
    expect(script).toContain('if ARGV[6] ~= "" then record.verificationVersion = ARGV[6] end');
    expect(script).toContain('if ARGV[7] ~= "" then record.authoritativeProofId = ARGV[7] end');
  });

  it("rejects a malformed verification version or proof id", async () => {
    const store = await loadStore();
    await expect(
      store.recordValidatedRun(WALLET, "2026-W37", 10, 0, "2026-09-01T00:00:00.000Z", 5, "", "proof")
    ).rejects.toThrow("Invalid verification version.");
    await expect(
      store.recordValidatedRun(WALLET, "2026-W37", 10, 0, "2026-09-01T00:00:00.000Z", 5, "authoritative-v1", "x".repeat(129))
    ).rejects.toThrow("Invalid authoritative proof id.");
    expect(evalFn).not.toHaveBeenCalled();
  });

  it("keeps the existing score/season-points/threshold validation", async () => {
    const store = await loadStore();
    await expect(store.recordValidatedRun(WALLET, "2026-W37", -1, 0, "t", 5)).rejects.toThrow("Invalid run score.");
    await expect(store.recordValidatedRun(WALLET, "2026-W37", NaN, 0, "t", 5)).rejects.toThrow("Invalid run score.");
    await expect(store.recordValidatedRun(WALLET, "2026-W37", 10, -1, "t", 5)).rejects.toThrow("Invalid season points.");
    await expect(store.recordValidatedRun(WALLET, "2026-W37", 10, 0, "t", 0)).rejects.toThrow("Invalid eligibility threshold.");
    expect(evalFn).not.toHaveBeenCalled();
  });

  it("still maintains the per-week wallet index after recording", async () => {
    const store = await loadStore();
    await store.recordValidatedRun(WALLET, "2026-W37", 10, 0, "2026-09-01T00:00:00.000Z", 5, "authoritative-v1", "proof-1");
    expect(saddFn).toHaveBeenCalledWith("mpgrhub:games:playerweek-index:2026-W37", "0x2222222222222222222222222222222222222222");
  });
});
