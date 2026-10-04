// lib/executor/__tests__/hardening-invariants.test.ts
//
// PHASE 4 HARDENING — §17 explicit cross-cutting invariants. Each test pins
// ONE invariant by name so docs/AUTONOMY-HARDENING.md can reference them
// individually. Authorization-matrix and verification-matrix depth lives in
// the dedicated hardening suites; this file pins the invariants that span
// modules (fee math, nonce/actionId determinism, slot single-use).

import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  computeExecutorFee,
  applySlippage,
} from "@/lib/executor/executor-fee";
import {
  EXECUTOR_MAX_FEE_BPS,
  EXECUTOR_BPS_DENOMINATOR,
  EXECUTOR_DEFAULT_FEE_BPS,
} from "@/lib/executor/executor-config";
import {
  delegatedActionId,
  delegatedPermitNonce,
  delegatedPolicyHash,
} from "@/lib/executor/delegated-executor";
import {
  delegatedSlotId,
  policyHashFor,
  selectDelegatedSlot,
  type DelegatedAuthorizationSlot,
} from "@/lib/autonomy/delegated-authorization";
import type { AutonomyPolicy } from "@/lib/autonomy/types";

const USER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const SELL = getAddress("0x00000000000000000000000000000000000000a5") as Address;
const BUY = getAddress("0x00000000000000000000000000000000000000b7") as Address;
const NOW = new Date("2026-10-01T00:00:00Z");
const DEADLINE = Math.floor(NOW.getTime() / 1000) + 1800;
const AMOUNT = "100000000";

function makePolicy(over: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    id: "pol-inv",
    wallet: USER,
    chainId: 84532,
    actions: ["swap"],
    sellToken: SELL,
    buyToken: BUY,
    maxPerTradeRaw: AMOUNT,
    maxDailyRaw: "1000000000",
    maxSlippageBps: 500,
    maxActionsPerDay: 5,
    enabled: true,
    createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 6 * 3600_000).toISOString(),
    authorizedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    authorizationRef: "hardening",
    ...over,
  };
}

function validSlot(over: Partial<DelegatedAuthorizationSlot> = {}): DelegatedAuthorizationSlot {
  const policy = makePolicy();
  return {
    id: delegatedSlotId(policy.id, "goal-1", 0),
    wallet: USER,
    chainId: 84532,
    policyId: policy.id,
    goalId: "goal-1",
    slotIndex: 0,
    permit: { token: SELL, amount: AMOUNT, nonce: "100", deadline: DEADLINE },
    witness: {
      owner: USER,
      buyToken: BUY,
      minAmountOut: "1000",
      deadline: DEADLINE,
      actionId: delegatedActionId("goal-1"),
      policyHash: policyHashFor(policy),
    },
    signature: ("0x" + "22".repeat(65)) as Hex2,
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    ...over,
  };
}
type Hex2 = `0x${string}`;

const CTX = (policy: AutonomyPolicy | null = makePolicy()) => ({
  now: NOW,
  policy,
  sellToken: SELL,
  buyToken: BUY,
  sellAmountRaw: AMOUNT,
  liveMinBuyAmountRaw: "1000",
});

// INV-1: one slot ⇒ at most one successful execution.
describe("INV-1 single-execution-per-slot", () => {
  it("a consumed slot can never be selected again (filtered out => NO_SLOTS, fail-closed)", () => {
    const slot = validSlot({ consumedAt: new Date(NOW.getTime() + 1000).toISOString() });
    const v = selectDelegatedSlot([slot], CTX());
    expect(v.authorized).toBe(false);
    expect(v.reason).toBe("NO_SLOTS");
    expect(v.slot).toBeUndefined();
  });

  it("a revoked slot can never be selected again (filtered out => NO_SLOTS, fail-closed)", () => {
    const slot = validSlot({ revokedAt: new Date(NOW.getTime() + 1000).toISOString() });
    const v = selectDelegatedSlot([slot], CTX());
    expect(v.authorized).toBe(false);
    expect(v.reason).toBe("NO_SLOTS");
    expect(v.slot).toBeUndefined();
  });

  it("a consumed slot never shadows a usable one (selection skips it, by index)", () => {
    const consumed = validSlot({ consumedAt: new Date(NOW.getTime() + 1000).toISOString(), slotIndex: 0, goalId: "goal-1" });
    const usable = validSlot({ slotIndex: 1, goalId: "goal-2", id: delegatedSlotId(makePolicy().id, "goal-2", 1), permit: { token: SELL, amount: AMOUNT, nonce: "101", deadline: DEADLINE } });
    // goal-2's witness must match its own actionId
    usable.witness.actionId = delegatedActionId("goal-2");
    const v = selectDelegatedSlot([consumed, usable], CTX());
    expect(v.authorized).toBe(true);
    expect(v.slot?.slotIndex).toBe(1);
  });

  it("an expired slot can never be selected again (permit deadline in the past)", () => {
    const slot = validSlot({ permit: { token: SELL, amount: AMOUNT, nonce: "100", deadline: DEADLINE - 1 } });
    const v = selectDelegatedSlot([slot], CTX());
    expect(v.authorized).toBe(false);
    expect(v.reason).toBe("SLOT_EXPIRED");
  });
});

// INV-2: signed bindings are immutable + deterministic post-authorization.
describe("INV-2 signed bindings deterministic and immutable", () => {
  it("nonce derives ONLY from goalId+slotIndex; actionId ONLY from goalId", () => {
    expect(delegatedPermitNonce("goal-abc", 0)).toBe(delegatedPermitNonce("goal-abc", 0));
    expect(delegatedPermitNonce("goal-abc", 0)).not.toBe(delegatedPermitNonce("goal-abc", 1));
    expect(delegatedPermitNonce("goal-abc", 0)).not.toBe(delegatedPermitNonce("goal-abcd", 0));
    expect(delegatedActionId("goal-abc")).toBe(delegatedActionId("goal-abc"));
    expect(delegatedActionId("goal-abc")).not.toBe(delegatedActionId("goal-abd"));
    expect(BigInt(delegatedPermitNonce("goal-abc", 0))).toBeGreaterThanOrEqual(0n);
  });

  it("policyHash pins id/wallet/chain/pair/maxPerTrade/slippage/expiry — any mutation changes it", () => {
    const policy = makePolicy();
    expect(delegatedPolicyHash(policy)).toBe(delegatedPolicyHash({ ...policy }));
    expect(delegatedPolicyHash(policy)).toMatch(/^0x[a-f0-9]{64}$/);
    for (const mutation of [
      { maxPerTradeRaw: "999" },
      { maxSlippageBps: 1 },
      { buyToken: SELL },
      { sellToken: BUY },
      { expiresAt: new Date(NOW.getTime() + 1).toISOString() },
    ]) {
      expect(delegatedPolicyHash({ ...policy, ...mutation }), JSON.stringify(mutation)).not.toBe(delegatedPolicyHash(policy));
    }
  });

  it("DOCUMENTS the policyHash field set (maxDailyRaw/maxActionsPerDay intentionally NOT hashed)", () => {
    // delegatedPolicyHash V1 covers: policyId, wallet, chainId, sellToken,
    // buyToken, maxPerTradeRaw, maxSlippageBps, expiresAt. The daily and
    // per-day-action caps are enforced LIVE from the store at every
    // evaluation (evaluatePolicyAgainstAction) and are therefore not part
    // of the witness — recorded as finding F-6 (INFORMATIONAL) in
    // docs/AUTONOMY-HARDENING.md.
    const mutated = delegatedPolicyHash(makePolicy({ maxDailyRaw: "999999" }));
    expect(mutated).toBe(delegatedPolicyHash(makePolicy()));
  });
});

// INV-3: fee bounded by cap, integer-exact (BigInt), never favorable rounding.
describe("INV-3 fee bounded and integer-exact", () => {
  it("fee = floor(gross × feeBps / 10_000) holds exactly; swap + fee == gross; cap respected", () => {
    for (const gross of [400n, 10_000n, 10_001n, 999_999n, 10n ** 18n, (1n << 53n) + 1n, 10n ** 30n]) {
      const r = computeExecutorFee(gross, EXECUTOR_DEFAULT_FEE_BPS);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const expectedFee = (gross * BigInt(EXECUTOR_DEFAULT_FEE_BPS)) / EXECUTOR_BPS_DENOMINATOR;
      expect(r.value.feeAmount).toBe(expectedFee);
      expect(r.value.swapAmountIn).toBe(gross - expectedFee);
      expect(r.value.feeAmount).toBeLessThanOrEqual(gross);
      expect(r.value.feeBps).toBeLessThanOrEqual(EXECUTOR_MAX_FEE_BPS);
    }
  });

  it("dust amounts that would round the fee to zero are refused (FeeRoundsToZero mirrored host-side)", () => {
    const r = computeExecutorFee(399n, EXECUTOR_DEFAULT_FEE_BPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FEE_ROUNDS_TO_ZERO");
  });

  it("slippage helper is monotone and bounded: minOut ≤ expected, 0 bps is identity, ≥10_000 refused", () => {
    const expected = 777_000n;
    expect(applySlippage(expected, 0)).toBe(expected);
    expect(applySlippage(expected, 25)).toBeLessThanOrEqual(expected);
    expect(applySlippage(expected, 100)).toBeLessThanOrEqual(applySlippage(expected, 25));
    expect(() => applySlippage(expected, 10_000)).toThrow(RangeError);
    expect(() => applySlippage(expected, 12.5)).toThrow(RangeError);
  });
});

// INV-4/5 gate coverage cross-reference (adversarial proofs live elsewhere).
describe("INV-4/5 gate coverage cross-reference", () => {
  it("documents where each hard gate is adversarially proven", () => {
    // INV-4 (revoked/expired): hardening-authorization §2 + INV-1 above.
    // INV-5 (emergency/flag): hardening-concurrency §12 +
    // autonomy-routes-security (flag OFF → 404s).
    // INV-6 (uncertain never rebroadcast): hardening-scheduler-idempotency
    // restart test + runtime.test uncertain-broadcast test.
    expect(EXECUTOR_MAX_FEE_BPS).toBeLessThanOrEqual(10_000);
  });
});
