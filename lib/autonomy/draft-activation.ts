// lib/autonomy/draft-activation.ts
//
// STANDING-DELEGATION CHECK for chat-draft activation (client-safe, pure).
//
// Activating a REVIEW-ONLY chat draft normally needs ONE wallet signature —
// a Permit2 witness slot binding the exact amount, pair, min output, action
// and policy. But a wallet that ALREADY holds a live, unconsumed,
// unexpired slot (plus its policy allowance) covering the draft's pair,
// per-trade amount and daily cap can activate with NO new wallet popup:
// the goal is created bound to the covering policy and the runtime can
// redeem the existing slot (same policyHash scope, same pair, exact amount,
// live nonce).
//
// Fail-closed on purpose: EVERY predicate must hold, addresses compare
// case-insensitively, amounts compare as integers, and a slot whose signed
// amount differs by one base unit does NOT cover (selectDelegatedSlot
// enforces exact-amount equality at execution, so a ">= amount" slot would
// only produce a doomed broadcast). Everything here is read-only display/
// decision logic — the server re-validates every field on every POST.
//
// SECURITY BOUNDARY (stated, not weakened): a Permit2 witness slot also
// carries a goal-bound actionId, and the executor re-checks it at broadcast
// (intentId == signed actionId, else revert). So a covering slot can only
// ever fund a broadcast within what it literally says; if the executing
// goal differs from the slot's own goal, the executor refuses the swap
// fail-closed (nothing is sent, no fee moves) and the goal parks with an
// explicit failure the wallet can see in its goal history. Coverage here
// therefore NEVER risks an unauthorized send — worst case is an honest
// "could not execute" outcome, never a broadcast outside the signed bounds.
//
// The inputs are the PUBLIC projections the UI already holds
// (AutonomyPolicyView / DelegatedSlotView from hooks/useAgentAutonomy), so
// the same predicates work for server records via serverSlotToLike().

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
  /** Unix-seconds deadline shared by the permit and the witness. */
  deadline: number;
  consumedAt: string | null;
  revokedAt: string | null;
}

/** What an open chat draft needs before it can execute. */
export interface DraftActivationNeed {
  /** Chain the goal will be created on (the delegated chain). */
  chainId: number;
  /** Spend-token address (lowercase-insensitive). */
  sellToken: string;
  /** Buy-token address (lowercase-insensitive). */
  buyToken: string;
  /** Base-unit sell amount per trade (decimal string). */
  sellAmountRaw: string;
  /** Base-unit daily cap the draft wants (decimal string). */
  maxDailyRaw: string;
  now: Date;
}

export interface CoveringDelegation {
  policyId: string;
  slotId: string;
  /** Goal the covering slot was signed for (display/debug only). */
  goalId: string;
  slotIndex: number;
}

/** Adapts a server DelegatedAuthorizationSlot record to the flat check shape. */
export function serverSlotToLike(slot: {
  id: string;
  policyId: string;
  goalId: string;
  slotIndex: number;
  permit: { token: string; amount: string; deadline: number };
  witness: { buyToken: string; minAmountOut: string; deadline: number };
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
    deadline: Math.min(slot.permit.deadline, slot.witness.deadline),
    consumedAt: slot.consumedAt ?? null,
    revokedAt: slot.revokedAt ?? null,
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The policy leg of the coverage: live, unexpired, same pair, big enough caps. */
export function policyCoversDraft(policy: DelegationPolicyLike, need: DraftActivationNeed): boolean {
  if (!policy.enabled || policy.revokedAt) return false;
  if (policy.chainId !== need.chainId) return false;
  if (new Date(policy.expiresAt).getTime() <= need.now.getTime()) return false;
  if (!sameAddress(policy.sellToken, need.sellToken) || !sameAddress(policy.buyToken, need.buyToken)) return false;
  try {
    if (BigInt(policy.maxPerTradeRaw) < BigInt(need.sellAmountRaw)) return false;
    if (BigInt(policy.maxDailyRaw) < BigInt(need.maxDailyRaw)) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * The slot leg of the coverage: unexpired, unconsumed, unrevoked, same
 * pair, and an EXACT base-unit amount match — the only shape the runtime's
 * selectDelegatedSlot can actually redeem (AMOUNT_MISMATCH is equality
 * there), with a positive signed floor.
 */
export function slotCoversDraft(slot: DelegationSlotLike, policyId: string, need: DraftActivationNeed): boolean {
  if (slot.policyId !== policyId) return false;
  if (slot.revokedAt || slot.consumedAt) return false;
  const nowSeconds = Math.floor(need.now.getTime() / 1000);
  if (slot.deadline <= nowSeconds) return false;
  if (!sameAddress(slot.sellToken, need.sellToken)) return false;
  if (!sameAddress(slot.buyToken, need.buyToken)) return false;
  try {
    if (BigInt(slot.amountRaw) !== BigInt(need.sellAmountRaw)) return false;
    if (BigInt(slot.minAmountOutRaw) <= 0n) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Finds a standing delegation covering the draft, if one exists. Slots are
 * scanned in slotIndex order (policies by id) for determinism. Returns null
 * when nothing covers — the caller must then ask the wallet for exactly ONE
 * signature.
 */
export function findCoveringDelegation(
  policies: readonly DelegationPolicyLike[],
  slots: readonly DelegationSlotLike[],
  need: DraftActivationNeed,
): CoveringDelegation | null {
  const candidates = policies
    .filter((p) => policyCoversDraft(p, need))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const policy of candidates) {
    const usable = slots
      .filter((s) => slotCoversDraft(s, policy.id, need))
      .sort((a, b) => a.slotIndex - b.slotIndex);
    const slot = usable[0];
    if (slot) {
      return { policyId: policy.id, slotId: slot.id, goalId: slot.goalId, slotIndex: slot.slotIndex };
    }
  }
  return null;
}
