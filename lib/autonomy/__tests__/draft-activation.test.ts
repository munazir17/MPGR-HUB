import { describe, expect, it } from "vitest";

// GOAL-BOUND STANDING-DELEGATION predicates (lib/autonomy/draft-activation.ts).
//
// A Permit2 witness slot binds an actionId derived from the goal it was
// signed FOR; the executor reverts any broadcast whose intentId differs from
// the signed actionId. So a slot can only ever fund ITS OWN goal — coverage
// is goal-bound or it does not exist. These tests lock that: another goal's
// slot NEVER covers, no matter how well it matches pair and amount.

import {
  findLiveSlotBoundToGoal,
  serverSlotToLike,
  type DelegationPolicyLike,
  type DelegationSlotLike,
} from "@/lib/autonomy/draft-activation";
import { delegatedActionId } from "@/lib/executor/delegated-executor";

const NOW = new Date("2026-10-14T12:00:00Z");

// The REAL derivation (pure keccak, client-safe) — the check must match the
// same binding the executor enforces on-chain.
const actionIdOf = (goalId: string) => delegatedActionId(goalId);

const GOAL = {
  id: "goal_this",
  sellToken: "0x1111111111111111111111111111111111111111",
  buyToken: "0x2222222222222222222222222222222222222222",
  sellAmountRaw: "50000000", // 50 USDC
};

const POLICY: DelegationPolicyLike = {
  id: "policy_1",
  chainId: 8453,
  enabled: true,
  revokedAt: null,
  expiresAt: "2026-11-01T00:00:00Z",
  sellToken: GOAL.sellToken,
  buyToken: GOAL.buyToken,
  maxPerTradeRaw: "50000000",
  maxDailyRaw: "100000000",
};

/** A live slot bound to goal_this — the ONLY shape that covers. */
const OWN_LIVE_SLOT: DelegationSlotLike = {
  id: "slot_own_0",
  policyId: "policy_1",
  goalId: GOAL.id,
  slotIndex: 0,
  sellToken: GOAL.sellToken,
  amountRaw: GOAL.sellAmountRaw,
  buyToken: GOAL.buyToken,
  minAmountOutRaw: "140000000",
  actionId: actionIdOf(GOAL.id),
  deadline: Math.floor(NOW.getTime() / 1000) + 3600,
  consumedAt: null,
  revokedAt: null,
};

/** Same pair, same EXACT amount, live — but signed for a DIFFERENT goal. */
const OTHER_GOAL_SLOT: DelegationSlotLike = {
  ...OWN_LIVE_SLOT,
  id: "slot_other_0",
  goalId: "goal_other",
  actionId: actionIdOf("goal_other"),
};

describe("findLiveSlotBoundToGoal (goal-bound standing delegation)", () => {
  it("a live slot BOUND TO THIS goal covers", () => {
    expect(findLiveSlotBoundToGoal([POLICY], [OWN_LIVE_SLOT], GOAL, NOW)).toMatchObject({
      policyId: "policy_1",
      slotId: "slot_own_0",
    });
  });

  it("a covering slot from a DIFFERENT goal does NOT cover — even with identical pair and amount", () => {
    expect(findLiveSlotBoundToGoal([POLICY], [OTHER_GOAL_SLOT], GOAL, NOW)).toBeNull();
  });

  it("a slot whose witness actionId does not derive from THIS goal id does NOT cover (tampered binding)", () => {
    expect(
      findLiveSlotBoundToGoal(
        [POLICY],
        [{ ...OWN_LIVE_SLOT, actionId: actionIdOf("goal_other") }],
        GOAL,
        NOW,
      ),
    ).toBeNull();
  });

  it("consumed, revoked, expired, wrong-pair, wrong-amount, or dead-policy slots never cover", () => {
    expect(findLiveSlotBoundToGoal([POLICY], [{ ...OWN_LIVE_SLOT, consumedAt: NOW.toISOString() }], GOAL, NOW)).toBeNull();
    expect(findLiveSlotBoundToGoal([POLICY], [{ ...OWN_LIVE_SLOT, revokedAt: NOW.toISOString() }], GOAL, NOW)).toBeNull();
    expect(findLiveSlotBoundToGoal([POLICY], [{ ...OWN_LIVE_SLOT, deadline: Math.floor(NOW.getTime() / 1000) }], GOAL, NOW)).toBeNull();
    expect(findLiveSlotBoundToGoal([POLICY], [{ ...OWN_LIVE_SLOT, buyToken: "0x4444444444444444444444444444444444444444" }], GOAL, NOW)).toBeNull();
    // EXACT amount equality: a bigger slot is not a covering slot either.
    expect(findLiveSlotBoundToGoal([POLICY], [{ ...OWN_LIVE_SLOT, amountRaw: "50000001" }], GOAL, NOW)).toBeNull();
    expect(findLiveSlotBoundToGoal([POLICY], [{ ...OWN_LIVE_SLOT, minAmountOutRaw: "0" }], GOAL, NOW)).toBeNull();
    expect(findLiveSlotBoundToGoal([{ ...POLICY, enabled: false }], [OWN_LIVE_SLOT], GOAL, NOW)).toBeNull();
    expect(findLiveSlotBoundToGoal([{ ...POLICY, revokedAt: NOW.toISOString() }], [OWN_LIVE_SLOT], GOAL, NOW)).toBeNull();
    expect(findLiveSlotBoundToGoal([{ ...POLICY, expiresAt: "2026-10-01T00:00:00Z" }], [OWN_LIVE_SLOT], GOAL, NOW)).toBeNull();
    expect(findLiveSlotBoundToGoal([{ ...POLICY, maxPerTradeRaw: "49999999" }], [OWN_LIVE_SLOT], GOAL, NOW)).toBeNull();
  });

  it("no slots at all → null (the caller must request the one new signature)", () => {
    expect(findLiveSlotBoundToGoal([POLICY], [], GOAL, NOW)).toBeNull();
  });

  it("serverSlotToLike flattens the server record including the witness actionId", () => {
    const like = serverSlotToLike({
      id: "slot_1",
      policyId: "policy_1",
      goalId: "goal_1",
      slotIndex: 2,
      permit: { token: "0xaa", amount: "5", deadline: 200 },
      witness: { buyToken: "0xbb", minAmountOut: "7", deadline: 100, actionId: "0xfeed" },
      consumedAt: null,
    });
    expect(like).toMatchObject({
      sellToken: "0xaa",
      amountRaw: "5",
      buyToken: "0xbb",
      minAmountOutRaw: "7",
      actionId: "0xfeed",
      deadline: 100,
      slotIndex: 2,
    });
  });
});
