// lib/autonomy/delegated-authorization.ts
//
// Phase 2 — Permit2 WITNESS AUTHORIZATION SLOTS (the cryptographic boundary).
//
// MODEL (forced by the Phase-1 contract itself): one Permit2 witness
// authorization binds the EXACT amount, output token, minimum output,
// deadline, actionId and policyHash, and burns one Permit2 nonce on use.
// One signature is therefore exactly ONE executable trade. The user signs
// a bounded number of SLOTS at goal activation (while present and
// authenticated); the runtime can only broadcast within what a slot
// literally says. There is no other delegated authorization format.
//
// FAIL-CLOSED: every predicate here refuses on missing/unknown data.
// Slots are consumed conservatively (any broadcast attempt consumes —
// over-counting is safe; under-counting could double-spend a nonce).
// The signature bytes are stored server-side (required to broadcast the
// user's own authorization) but are NEVER logged and never leave the
// execution path. No private key exists anywhere in this model.

import type { Address, Hex } from "viem";

import { DELEGATED_EXECUTOR_CHAIN_ID, delegatedPolicyHash } from "@/lib/executor/delegated-executor";

import { DELEGATED_ADAPTER_ID, type AutonomyPolicy } from "./types";

export { DELEGATED_ADAPTER_ID };

/** Hard ceiling on slots per authorization request (bounds signatures + storage). */
export const MAX_DELEGATED_SLOTS = 5;

/** A pre-signed, single-use execution slot. `signature` is never logged. */
export interface DelegatedAuthorizationSlot {
  id: string;
  wallet: Address; // lowercase; must equal permit witness owner + signer
  chainId: 84532;
  policyId: string;
  goalId: string;
  slotIndex: number;
  permit: { token: Address; amount: string; nonce: string; deadline: number };
  witness: { owner: Address; buyToken: Address; minAmountOut: string; deadline: number; actionId: Hex; policyHash: Hex };
  signature: Hex;
  createdAt: string;
  consumedAt?: string | null;
  consumedByTxHash?: string | null;
  revokedAt?: string | null;
}

export type DelegatedSlotRejection =
  | "NO_SLOTS"
  | "SLOT_REVOKED"
  | "SLOT_CONSUMED"
  | "SLOT_EXPIRED"
  | "OWNER_MISMATCH"
  | "CHAIN_MISMATCH"
  | "TOKEN_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "OUTPUT_TOKEN_MISMATCH"
  | "MIN_OUT_WEAKER_THAN_SIGNED"
  | "POLICY_HASH_MISMATCH"
  | "ACTION_MISMATCH"
  | "POLICY_MISMATCH";

export interface DelegatedSlotVerdict {
  authorized: boolean;
  reason?: DelegatedSlotRejection | string;
  slot?: DelegatedAuthorizationSlot;
}

export interface DelegatedAuthorizationStore {
  saveSlots(slots: DelegatedAuthorizationSlot[]): Promise<number>;
  listSlots(wallet: string, policyId: string): Promise<DelegatedAuthorizationSlot[]>;
  markConsumed(id: string, wallet: string, txHash: string, at: string): Promise<boolean>;
  markRevoked(id: string, wallet: string, at: string): Promise<boolean>;
}

/** In-memory implementation (tests); production wires the Redis-backed one. */
export class InMemoryDelegatedAuthorizationStore implements DelegatedAuthorizationStore {
  private readonly slots = new Map<string, DelegatedAuthorizationSlot>();
  async saveSlots(slots: DelegatedAuthorizationSlot[]): Promise<number> {
    for (const s of slots) {
      const dupe = [...this.slots.values()].find((x) => x.permit.nonce === s.permit.nonce && x.wallet === s.wallet);
      if (dupe) throw new Error("duplicate permit nonce");
      this.slots.set(s.id, { ...s });
    }
    return slots.length;
  }
  async listSlots(wallet: string, policyId: string): Promise<DelegatedAuthorizationSlot[]> {
    return [...this.slots.values()].filter((s) => s.wallet === wallet && s.policyId === policyId);
  }
  async markConsumed(id: string, wallet: string, txHash: string, at: string): Promise<boolean> {
    const s = this.slots.get(id);
    if (!s || s.wallet !== wallet || s.consumedAt) return false;
    this.slots.set(id, { ...s, consumedAt: at, consumedByTxHash: txHash });
    return true;
  }
  async markRevoked(id: string, wallet: string, at: string): Promise<boolean> {
    const s = this.slots.get(id);
    if (!s || s.wallet !== wallet || s.revokedAt) return false;
    this.slots.set(id, { ...s, revokedAt: at });
    return true;
  }
}

/** Deterministic slot id (goal + policy + index). */
export function delegatedSlotId(policyId: string, goalId: string, slotIndex: number): string {
  return `slot-${policyId}-${goalId}-${slotIndex}`;
}

/** The policyHash an authorization for this policy must carry. */
export function policyHashFor(policy: AutonomyPolicy): Hex {
  return delegatedPolicyHash({
    id: policy.id,
    wallet: policy.wallet,
    chainId: policy.chainId,
    sellToken: policy.sellToken,
    buyToken: policy.buyToken,
    maxPerTradeRaw: policy.maxPerTradeRaw,
    maxSlippageBps: policy.maxSlippageBps,
    expiresAt: policy.expiresAt,
  });
}

export interface SlotMatchContext {
  now: Date;
  policy: AutonomyPolicy | null;
  /** Goal trade the runtime wants to execute (all lowercase addresses). */
  sellToken: Address;
  buyToken: Address;
  sellAmountRaw: string;
  /** Live-quote minimum output at policy slippage (base-unit string). */
  liveMinBuyAmountRaw: string;
}

/**
 * Picks the FIRST usable slot for (wallet, policy) against the live trade,
 * enforcing every binding. Read-only — consumption happens in executeSwap.
 */
export function selectDelegatedSlot(slots: DelegatedAuthorizationSlot[], ctx: SlotMatchContext): DelegatedSlotVerdict {
  if (!ctx.policy) return { authorized: false, reason: "POLICY_MISMATCH" };
  if (ctx.policy.chainId !== DELEGATED_EXECUTOR_CHAIN_ID) return { authorized: false, reason: "CHAIN_MISMATCH" };
  const expectedPolicyHash = policyHashFor(ctx.policy).toLowerCase();
  const nowSeconds = Math.floor(ctx.now.getTime() / 1000);

  const usable = slots
    .filter((s) => !s.revokedAt && !s.consumedAt)
    .sort((a, b) => a.slotIndex - b.slotIndex);
  if (usable.length === 0) return { authorized: false, reason: "NO_SLOTS" };

  for (const slot of usable) {
    if (slot.chainId !== DELEGATED_EXECUTOR_CHAIN_ID) return { authorized: false, reason: "CHAIN_MISMATCH", slot };
    if (slot.permit.deadline <= nowSeconds || slot.witness.deadline <= nowSeconds) {
      return { authorized: false, reason: "SLOT_EXPIRED", slot };
    }
    if (slot.witness.owner.toLowerCase() !== slot.wallet) return { authorized: false, reason: "OWNER_MISMATCH", slot };
    if (slot.wallet.toLowerCase() !== ctx.policy.wallet.toLowerCase()) return { authorized: false, reason: "OWNER_MISMATCH", slot };
    if (slot.permit.token.toLowerCase() !== ctx.sellToken.toLowerCase()) return { authorized: false, reason: "TOKEN_MISMATCH", slot };
    if (BigInt(slot.permit.amount) !== BigInt(ctx.sellAmountRaw)) return { authorized: false, reason: "AMOUNT_MISMATCH", slot };
    if (slot.witness.buyToken.toLowerCase() !== ctx.buyToken.toLowerCase()) return { authorized: false, reason: "OUTPUT_TOKEN_MISMATCH", slot };
    if (slot.witness.policyHash.toLowerCase() !== expectedPolicyHash) return { authorized: false, reason: "POLICY_HASH_MISMATCH", slot };
    if (slot.witness.deadline !== slot.permit.deadline) return { authorized: false, reason: "SLOT_EXPIRED", slot };
    // The live quote (policy-clamped slippage) must still clear the SIGNED
    // floor. The executed minOut is the SIGNED value — never weaker.
    if (BigInt(slot.witness.minAmountOut) <= 0n) return { authorized: false, reason: "MIN_OUT_WEAKER_THAN_SIGNED", slot };
    if (BigInt(ctx.liveMinBuyAmountRaw) < BigInt(slot.witness.minAmountOut)) {
      return { authorized: false, reason: "MIN_OUT_WEAKER_THAN_SIGNED", slot };
    }
    return { authorized: true, slot };
  }
  return { authorized: false, reason: "NO_SLOTS" };
}

/** Checks a new slot against the policy BEFORE storing (server-side validation). */
export function validateNewSlotAgainstPolicy(slot: Omit<DelegatedAuthorizationSlot, "id">, policy: AutonomyPolicy): string | null {
  if (slot.wallet.toLowerCase() !== policy.wallet.toLowerCase()) return "OWNER_MISMATCH";
  if (slot.chainId !== DELEGATED_EXECUTOR_CHAIN_ID || policy.chainId !== DELEGATED_EXECUTOR_CHAIN_ID) return "CHAIN_MISMATCH";
  if (slot.permit.token.toLowerCase() !== policy.sellToken.toLowerCase()) return "TOKEN_MISMATCH";
  if (slot.witness.buyToken.toLowerCase() !== policy.buyToken.toLowerCase()) return "OUTPUT_TOKEN_MISMATCH";
  if (BigInt(slot.permit.amount) > BigInt(policy.maxPerTradeRaw)) return "AMOUNT_MISMATCH";
  if (slot.witness.policyHash.toLowerCase() !== policyHashFor(policy).toLowerCase()) return "POLICY_HASH_MISMATCH";
  if (slot.witness.owner.toLowerCase() !== slot.wallet) return "OWNER_MISMATCH";
  if (slot.witness.deadline !== slot.permit.deadline) return "SLOT_EXPIRED";
  if (slot.permit.deadline > Math.floor(new Date(policy.expiresAt).getTime() / 1000)) return "SLOT_EXPIRED";
  if (slot.permit.deadline <= Math.floor(new Date(slot.createdAt).getTime() / 1000)) return "SLOT_EXPIRED";
  if (BigInt(slot.witness.minAmountOut) <= 0n) return "MIN_OUT_WEAKER_THAN_SIGNED";
  return null;
}
