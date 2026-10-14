// lib/autonomy/draft-activation.ts
//
// GOAL-BOUND STANDING-DELEGATION CHECK for chat-draft activation
// (client-safe, pure).
//
// WHY ANOTHER GOAL'S SLOT CAN NEVER FUND THIS GOAL (production correction):
// a Permit2 witness slot binds an `actionId`, and `delegatedActionId` is
// derived from the goal the slot was signed FOR (`slot.goalId`). The executor
// re-checks this at broadcast — `SwapParams.intentId` must equal the signed
// witness `actionId`, else it reverts (MPGRExecutorDelegated InvalidWitness)
// — and the runtime broadcasts with `intentId = delegatedActionId(EXECUTING
// goal id)`. A slot signed for goal A therefore reverts for goal B:
// fail-closed on-chain. Creating a NEW goal "covered" by an old slot would
// produce a goal that can never execute (a doomed broadcast, operator gas
// burned, nothing sent). Coverage is therefore defined GOAL-BOUND:
//
//   A slot covers ONLY when it is bound to THIS goal —
//     slot.goalId === goal.id  AND
//     slot.witness.actionId === delegatedActionId(goal.id) —
//   and is live (unconsumed, unrevoked, unexpired), matches THIS goal's
//   pair and EXACT base-unit amount, and its policy is live and big enough.
//
// A brand-new draft goal cannot have such a slot yet, so activation of a
// chat draft ALWAYS takes the ONE-SIGNATURE path. No other goal's slot is
// ever reused.
//
// Fail-closed on purpose: EVERY predicate must hold, addresses compare
// case-insensitively, amounts compare as integers. This module is read-only
// decision logic — the server re-validates every field again, and the
// runtime's selectDelegatedSlot + the on-chain witness check are the
// authoritative gates.
//
// The inputs are the PUBLIC projections the UI already holds
// (AutonomyPolicyView / DelegatedSlotView from hooks/useAgentAutonomy), so
// the same predicates work for server records via serverSlotToLike().

import { delegatedActionId } from "@/lib/executor/delegated-executor";

/** Minimal policy shape the coverage check reads (public view compatible). */
export interface DelegationPolicyLike {
  id: string;
  chainId: number;
  enabled: boolean;
  revokedAt: string | null;
  expiresAt: string;
  sellToken: string;
  buyToken: string;
  maxPerTradeRaw: string;
  maxDailyRaw: string;
}

/** Minimal slot shape the coverage check reads (public view compatible). */
export interface DelegationSlotLike {
  id: string;
  policyId: string;
  /** The goal this slot was SIGNED for — slots never cover another goal. */
  goalId: string;
  slotIndex: number;
  /** Permit2 permitted token (the spend token). */
  sellToken: string;
  /** Permit2 permitted amount in base units (decimal string). */
  amountRaw: string;
  /** Witness buy token. */
  buyToken: string;
  /** Witness minimum output floor in base units (decimal string). */
  minAmountOutRaw: string;
  /** Witness actionId — must equal delegatedActionId(goalId). */
  actionId: string;
  /** Unix-seconds deadline shared by the permit and the witness. */
  deadline: number;
  consumedAt: string | null;
  revokedAt: string | null;
}

/** The goal a draft resolves to (for a new activation: the just-created goal). */
export interface DraftGoalRef {
  id: string;
  sellToken: string;
  buyToken: string;
  /** Base-unit sell amount per trade (decimal string). */
  sellAmountRaw: string;
}

export interface GoalSlotCoverage {
  policyId: string;
  slotId: string;
  slotIndex: number;
}

/** Adapts a server DelegatedAuthorizationSlot record to the flat check shape. */
export function serverSlotToLike(slot: {
  id: string;
  policyId: string;
  goalId: string;
  slotIndex: number;
  permit: { token: string; amount: string; deadline: number };
  witness: { buyToken: string; minAmountOut: string; deadline: number; actionId: string };
  consumedAt?: string | null;
  revokedAt?: string | null;
}): DelegationSlotLike {
  return {
    id: slot.id,
    policyId: slot.policyId,
    goalId: slot.goalId,
    slotIndex: slot.slotIndex,
    sellToken: slot.permit.token,
    amountRaw: slot.permit.amount,
    buyToken: slot.witness.buyToken,
    minAmountOutRaw: slot.witness.minAmountOut,
    actionId: slot.witness.actionId,
    deadline: Math.min(slot.permit.deadline, slot.witness.deadline),
    consumedAt: slot.consumedAt ?? null,
    revokedAt: slot.revokedAt ?? null,
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function policyIsLive(policy: DelegationPolicyLike | undefined, now: Date): policy is DelegationPolicyLike {
  if (!policy || !policy.enabled || policy.revokedAt) return false;
  return new Date(policy.expiresAt).getTime() > now.getTime();
}

/**
 * The ONLY standing-delegation path: a live, unconsumed, unexpired slot
 * already bound to THIS goal (slot.goalId === goal.id and its witness
 * actionId equals delegatedActionId(goal.id)), matching THIS goal's pair and
 * EXACT amount, under a live policy with big-enough caps. Returns null when
 * nothing qualifies — the caller must then ask the wallet for exactly ONE
 * new signature. A slot from ANY other goal never qualifies, no matter how
 * well it matches pair and amount.
 */
export function findLiveSlotBoundToGoal(
  policies: readonly DelegationPolicyLike[],
  slots: readonly DelegationSlotLike[],
  goal: DraftGoalRef,
  now: Date,
): GoalSlotCoverage | null {
  const policyById = new Map(policies.map((p) => [p.id, p]));
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expectedActionId = delegatedActionId(goal.id).toLowerCase();

  const bound = slots
    // BOUND TO THIS GOAL — never another goal's slot. Checked FIRST: pair and
    // amount similarity must never resurrect someone else's authorization.
    .filter((s) => s.goalId === goal.id)
    .filter((s) => !s.revokedAt && !s.consumedAt)
    .filter((s) => s.deadline > nowSeconds)
    // The witness binding, re-verified client-side against THIS goal id.
    .filter((s) => s.actionId.toLowerCase() === expectedActionId)
    .sort((a, b) => a.slotIndex - b.slotIndex);

  for (const slot of bound) {
    if (!sameAddress(slot.sellToken, goal.sellToken)) continue;
    if (!sameAddress(slot.buyToken, goal.buyToken)) continue;
    try {
      // EXACT base-unit equality — the only shape selectDelegatedSlot can
      // redeem (its AMOUNT_MISMATCH is equality), so "bigger" slots do not
      // cover either.
      if (BigInt(slot.amountRaw) !== BigInt(goal.sellAmountRaw)) continue;
      if (BigInt(slot.minAmountOutRaw) <= 0n) continue;
    } catch {
      continue;
    }
    const policy = policyById.get(slot.policyId);
    if (!policyIsLive(policy, now)) continue;
    try {
      if (BigInt(policy.maxPerTradeRaw) < BigInt(goal.sellAmountRaw)) continue;
    } catch {
      continue;
    }
    return { policyId: slot.policyId, slotId: slot.id, slotIndex: slot.slotIndex };
  }
  return null;
}
