// lib/autonomy/__tests__/hardening-authorization.test.ts
//
// PHASE 4 HARDENING — authorization boundaries (§2), Permit2/replay/nonce
// semantics (§3) and store idempotency (§5), adversarial style: every case
// mutates or forges a state that LOOKS almost valid and must fail closed
// BEFORE any broadcast. Deterministic; no chain, no timing dependence.

import { describe, expect, it, beforeEach } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  InMemoryDelegatedAuthorizationStore,
  delegatedSlotId,
  policyHashFor,
  selectDelegatedSlot,
  validateNewSlotAgainstPolicy,
  type DelegatedAuthorizationSlot,
} from "@/lib/autonomy/delegated-authorization";
import type { AutonomyPolicy } from "@/lib/autonomy/types";
import { delegatedActionId } from "@/lib/executor/delegated-executor";

const USER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const OTHER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const SELL = getAddress("0x00000000000000000000000000000000000000a5") as Address;
const BUY = getAddress("0x00000000000000000000000000000000000000b7") as Address;
const NOW = new Date("2026-10-01T00:00:00Z");
const DEADLINE = Math.floor(NOW.getTime() / 1000) + 1800;
const AMOUNT = "100000000";

function makePolicy(over: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    id: "pol-hard",
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
      minAmountOut: "900",
      deadline: DEADLINE,
      actionId: delegatedActionId("goal-1"),
      policyHash: policyHashFor(policy),
    },
    signature: ("0x" + "22".repeat(65)) as Hex,
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    ...over,
  };
}

const CTX = (policy: AutonomyPolicy | null = makePolicy()) => ({
  now: NOW,
  policy,
  sellToken: SELL,
  buyToken: BUY,
  sellAmountRaw: AMOUNT,
  liveMinBuyAmountRaw: "1000",
});

describe("hardening: authorization mutation boundaries (§2)", () => {
  it("accepts a fully valid authorization", () => {
    const v = selectDelegatedSlot([validSlot()], CTX());
    expect(v.authorized).toBe(true);
  });

  it("rejects EVERY single-field mutation toward a broader authorization", () => {
    const policy = makePolicy();
    const base = validSlot();
    const mutations: Array<[string, DelegatedAuthorizationSlot, () => Parameters<typeof selectDelegatedSlot>[1]]> = [
      ["wrong wallet slot", validSlot({ wallet: OTHER }), () => CTX(policy)],
      ["wrong chain", validSlot({ chainId: 8453 as never }), () => CTX(policy)],
      ["wrong sell token", validSlot({ permit: { ...base.permit, token: BUY } }), () => CTX(policy)],
      ["amount above signed bound", validSlot({ permit: { ...base.permit, amount: "100000001" } }), () => CTX(policy)],
      ["amount below signed bound (binding mismatch)", validSlot({ permit: { ...base.permit, amount: "99999999" } }), () => CTX(policy)],
      ["wrong buy token", validSlot({ witness: { ...base.witness, buyToken: SELL } }), () => CTX(policy)],
      ["modified deadline (permit)", validSlot({ permit: { ...base.permit, deadline: DEADLINE + 1 } }), () => CTX(policy)],
      ["modified deadline (witness)", validSlot({ witness: { ...base.witness, deadline: DEADLINE + 1 } }), () => CTX(policy)],
      ["modified actionId (not the goal's)", validSlot({ witness: { ...base.witness, actionId: ("0x" + "33".repeat(32)) as Hex } }), () => CTX(policy)],
      ["modified policyHash", validSlot({ witness: { ...base.witness, policyHash: ("0x" + "44".repeat(32)) as Hex } }), () => CTX(policy)],
      ["modified owner", validSlot({ witness: { ...base.witness, owner: OTHER } }), () => CTX(policy)],
      ["minOut below signed floor (live < signed)", validSlot(), () => ({ ...CTX(policy), liveMinBuyAmountRaw: "899" })],
      ["zero minOut", validSlot({ witness: { ...base.witness, minAmountOut: "0" } }), () => CTX(policy)],
      ["expired", validSlot({ permit: { ...base.permit, deadline: DEADLINE }, }), () => ({ ...CTX(policy), now: new Date(NOW.getTime() + 3601_000) })],
      ["revoked", validSlot({ revokedAt: NOW.toISOString() }), () => CTX(policy)],
      ["already consumed", validSlot({ consumedAt: NOW.toISOString(), consumedByTxHash: "0x" + "55".repeat(32) }), () => CTX(policy)],
      ["no slots", validSlot(), () => ({ ...CTX(policy), sellAmountRaw: "1" })],
      ["no policy", validSlot(), () => CTX(null)],
      ["policy on other chain", validSlot(), () => CTX(makePolicy({ chainId: 8453 as never }))],
      ["policy wallet mismatch (cross-wallet)", validSlot(), () => CTX(makePolicy({ wallet: OTHER }))],
      ["policy token swap", validSlot(), () => CTX(makePolicy({ sellToken: BUY, buyToken: SELL }))],
    ];
    for (const [name, slot, ctx] of mutations) {
      const v = selectDelegatedSlot([slot], ctx());
      expect(v.authorized, `${name} must NOT authorize`).toBe(false);
      expect(v.reason, name).toBeTruthy();
    }
  });

  it("a valid authorization cannot be widened by mixing slot fields with another slot", () => {
    const policy = makePolicy();
    const a = validSlot();
    // attacker splice: signed amount from a, raised minOut-era deadline + actionId from a "better" slot
    const spliced: DelegatedAuthorizationSlot = {
      ...a,
      permit: { ...a.permit, amount: "200000000" }, // double
      witness: { ...a.witness, minAmountOut: "1" }, // gutted floor
    };
    expect(selectDelegatedSlot([spliced], CTX(policy)).authorized).toBe(false);
  });
});

describe("hardening: pre-store policy validation (§2)", () => {
  it("validateNewSlotAgainstPolicy rejects out-of-policy slots before storage", () => {
    const policy = makePolicy();
    expect(validateNewSlotAgainstPolicy(validSlot(), policy)).toBeNull();
    expect(
      validateNewSlotAgainstPolicy(
        { ...validSlot(), witness: { ...validSlot().witness, policyHash: ("0x" + "66".repeat(32)) as Hex } },
        policy,
      ),
    ).toBeTruthy();
    expect(
      validateNewSlotAgainstPolicy({ ...validSlot(), wallet: OTHER }, policy),
    ).toBeTruthy();
  });
});

describe("hardening: single-use / replay / duplicate slots (§3)", () => {
  let store: InMemoryDelegatedAuthorizationStore;
  beforeEach(() => {
    store = new InMemoryDelegatedAuthorizationStore();
  });

  it("consumed slots can never be consumed again (replay)", async () => {
    const s = validSlot();
    await store.saveSlots([s]);
    expect(await store.markConsumed(s.id, USER, "0x" + "77".repeat(32), NOW.toISOString())).toBe(true);
    expect(await store.markConsumed(s.id, USER, "0x" + "88".repeat(32), NOW.toISOString())).toBe(false);
    const after = await store.getSlot(s.id, USER);
    expect(after?.consumedByTxHash).toBe("0x" + "77".repeat(32));
  });

  it("consumption is wallet-scoped (another wallet cannot consume or even read)", async () => {
    const s = validSlot();
    await store.saveSlots([s]);
    expect(await store.markConsumed(s.id, OTHER, "0x" + "99".repeat(32), NOW.toISOString())).toBe(false);
    expect(await store.getSlot(s.id, OTHER)).toBeNull();
    expect((await store.listSlots(OTHER)).find((x) => x.id === s.id)).toBeUndefined();
  });

  it("revoked slots cannot be consumed or re-revoked", async () => {
    const s = validSlot();
    await store.saveSlots([s]);
    expect(await store.markRevoked(s.id, USER, NOW.toISOString())).toBe(true);
    expect(await store.markConsumed(s.id, USER, "0x" + "aa".repeat(32), NOW.toISOString())).toBe(false);
    expect(await store.markRevoked(s.id, USER, NOW.toISOString())).toBe(false);
  });

  it("duplicate permit nonces are rejected atomically at save time", async () => {
    await store.saveSlots([validSlot()]);
    const dupe = validSlot({ id: delegatedSlotId("pol-hard", "goal-2", 0) });
    await expect(store.saveSlots([dupe])).rejects.toThrow(/duplicate permit nonce/);
  });

  it("REGRESSION (Phase-4 finding H-1): a consumed slot can NOT be overwritten by a re-save", async () => {
    const s = validSlot();
    await store.saveSlots([s]);
    await store.markConsumed(s.id, USER, "0x" + "bb".repeat(32), NOW.toISOString());
    // attacker (or bug) re-saves the same slot id with a fresh nonce to resurrect it
    const resurrect = validSlot({
      permit: { token: SELL, amount: AMOUNT, nonce: "999", deadline: DEADLINE + 60 },
    });
    await expect(store.saveSlots([resurrect])).rejects.toThrow(/consumed or revoked/);
    const after = await store.getSlot(s.id, USER);
    expect(after?.consumedAt, "consumed state must survive").toBeTruthy();
    expect(after?.permit.nonce).toBe("100");
  });

  it("REGRESSION (Phase-4 finding H-1): a revoked slot can NOT be overwritten either", async () => {
    const s = validSlot();
    await store.saveSlots([s]);
    await store.markRevoked(s.id, USER, NOW.toISOString());
    await expect(
      store.saveSlots([validSlot({ permit: { token: SELL, amount: AMOUNT, nonce: "1000", deadline: DEADLINE + 60 } })]),
    ).rejects.toThrow(/consumed or revoked/);
  });

  it("idempotency claim: same key claims once, release allows re-claim", async () => {
    const { InMemoryAutonomyStore } = await import("@/lib/autonomy/store");
    const s = new InMemoryAutonomyStore();
    expect(await s.claimExecution("goal:slot", 60)).toBe(true);
    expect(await s.claimExecution("goal:slot", 60)).toBe(false);
    await s.releaseExecution("goal:slot");
    expect(await s.claimExecution("goal:slot", 60)).toBe(true);
  });
});
