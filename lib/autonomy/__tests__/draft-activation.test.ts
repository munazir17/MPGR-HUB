import { describe, expect, it } from "vitest";

// STANDING-DELEGATION COVERAGE predicates (lib/autonomy/draft-activation.ts).
// Fail-closed by design: every predicate must hold for a delegation to count
// as "covering" a chat draft — the runtime re-validates everything again.

import {
  findCoveringDelegation,
  policyCoversDraft,
  serverSlotToLike,
  slotCoversDraft,
  type DelegationPolicyLike,
  type DelegationSlotLike,
} from "@/lib/autonomy/draft-activation";

const NOW = new Date("2026-10-14T12:00:00Z");

const NEED = {
  chainId: 8453,
  sellToken: "0x1111111111111111111111111111111111111111",
  buyToken: "0x2222222222222222222222222222222222222222",
  sellAmountRaw: "50000000", // 50 USDC
  maxDailyRaw: "100000000", // 100 USDC
  now: NOW,
};

const POLICY: DelegationPolicyLike = {
  id: "policy_1",
  chainId: 8453,
  enabled: true,
  revokedAt: null,
  expiresAt: "2026-11-01T00:00:00Z",
  sellToken: "0x1111111111111111111111111111111111111111",
  buyToken: "0x2222222222222222222222222222222222222222",
  maxPerTradeRaw: "50000000",
  maxDailyRaw: "100000000",
};

const SLOT: DelegationSlotLike = {
  id: "slot_1",
  policyId: "policy_1",
  goalId: "goal_1",
  slotIndex: 0,
  sellToken: "0x1111111111111111111111111111111111111111",
  amountRaw: "50000000",
  buyToken: "0x2222222222222222222222222222222222222222",
  minAmountOutRaw: "140000000",
  deadline: Math.floor(NOW.getTime() / 1000) + 3600,
  consumedAt: null,
  revokedAt: null,
};

describe("policyCoversDraft", () => {
  it("a live, unexpired, same-pair policy with big-enough caps covers", () => {
    expect(policyCoversDraft(POLICY, NEED)).toBe(true);
  });

  it("fails closed on disabled/revoked/expired/cross-chain/cross-pair/smaller caps", () => {
    expect(policyCoversDraft({ ...POLICY, enabled: false }, NEED)).toBe(false);
    expect(policyCoversDraft({ ...POLICY, revokedAt: NOW.toISOString() }, NEED)).toBe(false);
    expect(policyCoversDraft({ ...POLICY, expiresAt: "2026-10-01T00:00:00Z" }, NEED)).toBe(false);
    expect(policyCoversDraft({ ...POLICY, chainId: 84532 }, NEED)).toBe(false);
    expect(policyCoversDraft({ ...POLICY, buyToken: "0x3333333333333333333333333333333333333333" }, NEED)).toBe(false);
    expect(policyCoversDraft({ ...POLICY, maxPerTradeRaw: "49999999" }, NEED)).toBe(false);
    expect(policyCoversDraft({ ...POLICY, maxDailyRaw: "99999999" }, NEED)).toBe(false);
    expect(policyCoversDraft({ ...POLICY, maxPerTradeRaw: "not-a-number" }, NEED)).toBe(false);
  });
});

describe("slotCoversDraft", () => {
  it("an unexpired, unconsumed slot with the EXACT amount and a positive floor covers", () => {
    expect(slotCoversDraft(SLOT, "policy_1", NEED)).toBe(true);
  });

  it("consumed/revoked/expired slots never cover", () => {
    expect(slotCoversDraft({ ...SLOT, consumedAt: NOW.toISOString() }, "policy_1", NEED)).toBe(false);
    expect(slotCoversDraft({ ...SLOT, revokedAt: NOW.toISOString() }, "policy_1", NEED)).toBe(false);
    expect(slotCoversDraft({ ...SLOT, deadline: Math.floor(NOW.getTime() / 1000) }, "policy_1", NEED)).toBe(false);
  });

  it("AMOUNT coverage is EXACT equality (what the runtime can actually redeem)", () => {
    expect(slotCoversDraft({ ...SLOT, amountRaw: "50000001" }, "policy_1", NEED)).toBe(false);
    expect(slotCoversDraft({ ...SLOT, amountRaw: "1000000" }, "policy_1", NEED)).toBe(false);
  });

  it("pair mismatch, other policy, or a zero floor never cover", () => {
    expect(slotCoversDraft({ ...SLOT, buyToken: "0x4444444444444444444444444444444444444444" }, "policy_1", NEED)).toBe(false);
    expect(slotCoversDraft({ ...SLOT, policyId: "policy_other" }, "policy_1", NEED)).toBe(false);
    expect(slotCoversDraft({ ...SLOT, minAmountOutRaw: "0" }, "policy_1", NEED)).toBe(false);
  });
});

describe("findCoveringDelegation", () => {
  it("finds the covering (policy, slot) pair", () => {
    expect(findCoveringDelegation([POLICY], [SLOT], NEED)).toMatchObject({ policyId: "policy_1", slotId: "slot_1" });
  });

  it("returns null when the policy exists but no slot covers — one signature is required", () => {
    expect(findCoveringDelegation([POLICY], [], NEED)).toBeNull();
    expect(findCoveringDelegation([POLICY], [{ ...SLOT, consumedAt: NOW.toISOString() }], NEED)).toBeNull();
  });

  it("returns null when slots exist but no live policy covers the caps", () => {
    expect(findCoveringDelegation([], [SLOT], NEED)).toBeNull();
    expect(findCoveringDelegation([{ ...POLICY, maxDailyRaw: "1" }], [SLOT], NEED)).toBeNull();
  });

  it("serverSlotToLike flattens the server record and takes the tighter deadline", () => {
    const like = serverSlotToLike({
      id: "slot_1",
      policyId: "policy_1",
      goalId: "goal_1",
      slotIndex: 2,
      permit: { token: "0xaa", amount: "5", deadline: 200 },
      witness: { buyToken: "0xbb", minAmountOut: "7", deadline: 100 },
      consumedAt: null,
    });
    expect(like).toMatchObject({ sellToken: "0xaa", amountRaw: "5", buyToken: "0xbb", minAmountOutRaw: "7", deadline: 100, slotIndex: 2 });
  });
});
