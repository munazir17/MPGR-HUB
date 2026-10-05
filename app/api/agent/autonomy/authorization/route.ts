// app/api/agent/autonomy/authorization/route.ts
//
// Phase 2 delegated-authorization control plane (Base Sepolia 84532 ONLY).
// Bounded Permit2 witness authorization slots: the user pre-signs a small
// number of single-trade slots; the runtime can only broadcast within what
// a slot literally says. This route is the ONLY way slots enter the system.
//
//   GET     list the authenticated wallet's slots (public view — NO signature
//           bytes, ever), or inspect one via ?id=
//   POST    register newly signed slots — EVERY slot is re-validated and its
//           EIP-712 signature RECOVERED server-side; the slot is always bound
//           to the SIWE-authenticated wallet, never to client-supplied values
//   DELETE  revoke (?id=) — always available while the flag is on (revocation
//           is the user's safety control and is never blocked by the
//           emergency stop; emergency stop blocks NEW slots + execution)
//
// Fail-closed: no session -> 401; autonomy flag off -> 404; emergency stop on
// POST -> 503; store failure -> 503. Assisted/manual trading never touches
// this route.

import { NextResponse } from "next/server";
import { recoverAddress, type Address, type Hex } from "viem";

import { verifyTrustedOrigin, readJsonBody, requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import { checkRateLimit } from "@/lib/trade/trade-rate-limit";
import { isAutonomousAgentEnabled, isAutonomousExecutionEmergencyDisabled, AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { delegatedExecutionConfigured, requireWallet, system } from "@/lib/autonomy/api-helpers";
import {
  MAX_DELEGATED_SLOTS,
  delegatedSlotId,
  policyHashFor,
  validateNewSlotAgainstPolicy,
  type DelegatedAuthorizationSlot,
} from "@/lib/autonomy/delegated-authorization";
import {
  delegatedActionId,
  delegatedChainLabel,
  delegatedExecutorAddressFor,
  delegatedPermitDigest,
  isDelegatedChainId,
  walletSigningSupported,
} from "@/lib/executor/delegated-executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

const DECIMAL = /^\d{1,78}$/;
const SLOT_ID_RE = /^[a-zA-Z0-9_.-]{4,120}$/;

/** Public view of a slot: shows every bounded detail, NEVER the signature. */
function publicSlot(slot: DelegatedAuthorizationSlot, nowSeconds: number) {
  const status = slot.revokedAt
    ? ("revoked" as const)
    : slot.consumedAt
      ? ("consumed" as const)
      : slot.permit.deadline <= nowSeconds
        ? ("expired" as const)
        : ("active" as const);
  return {
    id: slot.id,
    policyId: slot.policyId,
    goalId: slot.goalId,
    slotIndex: slot.slotIndex,
    chainId: slot.chainId,
    wallet: slot.wallet,
    sellToken: slot.permit.token,
    amountRaw: slot.permit.amount,
    buyToken: slot.witness.buyToken,
    minAmountOutRaw: slot.witness.minAmountOut,
    deadline: slot.permit.deadline,
    deadlineIso: new Date(slot.permit.deadline * 1000).toISOString(),
    nonce: slot.permit.nonce,
    policyHash: slot.witness.policyHash,
    actionId: slot.witness.actionId,
    status,
    consumedAt: slot.consumedAt ?? null,
    consumedByTxHash: slot.consumedByTxHash ?? null,
    revokedAt: slot.revokedAt ?? null,
    createdAt: slot.createdAt,
    // signature: deliberately absent — authorization bytes never leave the server.
  };
}

function json(requestId: string) {
  return (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
}

function unavailable(requestId: string) {
  return json(requestId)({ error: "Authorization store unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = json(requestId);
  if (!isAutonomousAgentEnabled()) return respond({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const auth = await requireWallet(request);
  if (!auth) return respond({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const wallet = auth.wallet.toLowerCase();
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const policyId = url.searchParams.get("policyId") ?? "";
  try {
    if (id) {
      if (!SLOT_ID_RE.test(id)) return respond({ error: "Invalid slot id.", code: "INVALID_SLOT_ID" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      // getSlot is wallet-scoped — another wallet's slot reads as not-found.
      const slot = await system().slots.getSlot(id, wallet);
      if (!slot) return respond({ error: "Authorization slot not found.", code: "SLOT_NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      return respond({ slot: publicSlot(slot, Math.floor(Date.now() / 1000)) }, { headers: { "Cache-Control": "no-store" } });
    }
    const slots = await system().slots.listSlots(wallet, policyId || undefined);
    return respond(
      { slots: slots.map((s) => publicSlot(s, Math.floor(Date.now() / 1000))), maxSlots: MAX_DELEGATED_SLOTS, walletSigningSupported: walletSigningSupported() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return unavailable(requestId);
  }
}

interface ParsedIncomingSlot {
  permit: { token: Address; amount: string; nonce: string; deadline: number };
  witness: { owner: Address; buyToken: Address; minAmountOut: string; deadline: number; actionId: Hex; policyHash: Hex };
  signature: Hex;
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = json(requestId);
  if (!isAutonomousAgentEnabled()) return respond({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (isAutonomousExecutionEmergencyDisabled()) {
    return respond({ error: "Delegated execution is emergency-disabled. Existing slots stay revocable.", code: "EMERGENCY_DISABLED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const auth = await requireWallet(request);
  if (!auth) return respond({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const rate = await checkRateLimit(`${auth.wallet.toLowerCase()}:autonomy-authorization`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rate.allowed) {
    return respond({ error: "Too many requests. Please slow down.", code: "RATE_LIMITED" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) } });
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body = (parsedBody.value && typeof parsedBody.value === "object" ? parsedBody.value : {}) as Record<string, unknown>;

  const policyId = typeof body.policyId === "string" ? body.policyId : "";
  const goalIdRaw = typeof body.goalId === "string" ? body.goalId : "";
  const incoming = Array.isArray(body.slots) ? body.slots : null;
  if (!/^[a-z0-9_]{4,80}$/i.test(policyId) || !/^[a-z0-9_]{4,80}$/i.test(goalIdRaw) || !incoming || incoming.length < 1 || incoming.length > MAX_DELEGATED_SLOTS) {
    return respond({ error: "Invalid authorization request.", code: "INVALID_AUTHORIZATION" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const store = system();
    // 1) The policy must exist AND belong to the authenticated wallet.
    const policy = await store.store.getPolicy(policyId);
    if (!policy || policy.wallet.toLowerCase() !== auth.wallet.toLowerCase()) {
      return respond({ error: "Policy not found.", code: "POLICY_NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (policy.revokedAt) return respond({ error: "This policy is revoked.", code: "POLICY_REVOKED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (new Date(policy.expiresAt).getTime() <= Date.now()) return respond({ error: "This policy has expired.", code: "POLICY_EXPIRED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    // CHAIN BINDING (audit MC-1 remediation). Delegated slots exist for the
    // policy's OWN chain — Base mainnet (8453) or Base Sepolia (84532). The
    // chain is bound three ways: this record, the Permit2 EIP-712 domain the
    // user signs, and `policyHash` (whose canonical tuple carries
    // `uint256 chainId`). A cross-chain slot therefore cannot verify, and is
    // refused here first with an honest reason.
    if (!isDelegatedChainId(policy.chainId)) {
      return respond({ error: "Delegated authorization slots require a Base (8453) or Base Sepolia (84532) policy.", code: "POLICY_CHAIN_MISMATCH" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    // The chain must have a PINNED delegated executor, otherwise the user would
    // be signing an authorization for a contract that does not exist. Fail
    // closed with an explicit, operator-actionable reason.
    const executor = delegatedExecutorAddressFor(policy.chainId);
    if (!executor || !delegatedExecutionConfigured(policy.chainId)) {
      return respond(
        {
          error: `Delegated execution is not deployed on ${delegatedChainLabel(policy.chainId)} yet, so slots cannot be signed for it. The goal stays watch-only.`,
          code: "DELEGATED_EXECUTOR_NOT_CONFIGURED",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    // 2) The goal must exist, belong to the wallet, and bind to the policy —
    //    the actionId is recomputed from the goal id, never trusted.
    const goal = await store.store.getGoal(goalIdRaw);
    if (!goal || goal.wallet.toLowerCase() !== auth.wallet.toLowerCase()) {
      return respond({ error: "Goal not found.", code: "GOAL_NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (goal.policyId !== policyId) {
      return respond({ error: "Goal does not belong to this policy.", code: "GOAL_POLICY_MISMATCH" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    // 3) Max-slot limit across existing + incoming (policy scope).
    const existing = await store.slots.listSlots(auth.wallet.toLowerCase(), policyId);
    const activeExisting = existing.filter((s) => !s.revokedAt && !s.consumedAt);
    if (activeExisting.length + incoming.length > MAX_DELEGATED_SLOTS) {
      return respond({ error: `At most ${MAX_DELEGATED_SLOTS} active authorization slots per policy.`, code: "SLOT_LIMIT_REACHED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const existingIndexes = new Set(existing.map((s) => s.slotIndex));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const records: DelegatedAuthorizationSlot[] = [];

    for (const raw of incoming) {
      const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const permit = (s.permit && typeof s.permit === "object" ? s.permit : {}) as Record<string, unknown>;
      const witness = (s.witness && typeof s.witness === "object" ? s.witness : {}) as Record<string, unknown>;
      const slotIndex = typeof s.slotIndex === "number" && Number.isInteger(s.slotIndex) && s.slotIndex >= 0 && s.slotIndex < MAX_DELEGATED_SLOTS ? s.slotIndex : -1;
      const deadline = typeof permit.deadline === "number" && Number.isInteger(permit.deadline) ? permit.deadline : -1;
      const nonce = typeof permit.nonce === "string" && DECIMAL.test(permit.nonce) && permit.nonce !== "0" ? permit.nonce : "";
      const amount = typeof permit.amount === "string" && DECIMAL.test(permit.amount) && permit.amount !== "0" ? permit.amount : "";
      const minAmountOut = typeof witness.minAmountOut === "string" && DECIMAL.test(witness.minAmountOut) ? witness.minAmountOut : "";
      const token = typeof permit.token === "string" && permit.token.startsWith("0x") ? permit.token : "";
      const buyToken = typeof witness.buyToken === "string" && witness.buyToken.startsWith("0x") ? witness.buyToken : "";
      const actionId = typeof witness.actionId === "string" && /^0x[0-9a-fA-F]{64}$/.test(witness.actionId) ? witness.actionId : "";
      const policyHash = typeof witness.policyHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(witness.policyHash) ? witness.policyHash : "";
      const signature = typeof s.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(s.signature) ? s.signature : "";
      const owner = typeof witness.owner === "string" && witness.owner.startsWith("0x") ? witness.owner : "";
      if (slotIndex < 0 || deadline <= 0 || !nonce || !amount || !minAmountOut || !token || !buyToken || !actionId || !policyHash || !signature || !owner) {
        return respond({ error: "Malformed authorization slot.", code: "INVALID_AUTHORIZATION" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      if (existingIndexes.has(slotIndex) || records.some((r) => r.slotIndex === slotIndex)) {
        return respond({ error: "Duplicate slot index.", code: "SLOT_INDEX_REUSED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      existingIndexes.add(slotIndex);

      // 4) Bind to the AUTHENTICATED wallet — client-supplied owner values
      //    are compared, never trusted. Wallet is the session wallet
      //    (lowercase per the slot model), always.
      const walletBinding: Address = auth.wallet.toLowerCase() as Address;
      const record: DelegatedAuthorizationSlot = {
        id: delegatedSlotId(policyId, goalIdRaw, slotIndex),
        wallet: walletBinding,
        chainId: policy.chainId,
        policyId,
        goalId: goalIdRaw,
        slotIndex,
        permit: { token: token as Address, amount, nonce, deadline },
        witness: {
          owner: owner as Address,
          buyToken: buyToken as Address,
          minAmountOut,
          deadline: typeof witness.deadline === "number" ? witness.deadline : -1,
          actionId: actionId as Hex,
          policyHash: policyHash as Hex,
        },
        signature: signature as Hex,
        createdAt: new Date().toISOString(),
      };
      if (record.witness.deadline !== record.permit.deadline) {
        return respond({ error: "Permit and witness deadlines must match.", code: "INVALID_AUTHORIZATION" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      if (record.permit.deadline <= nowSeconds) {
        return respond({ error: "Authorization already expired.", code: "SLOT_EXPIRED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      // 5) Full server-side binding validation (exact tokens/amount/minOut
      //    floor/policyHash/deadlines — including the expiry-vs-policy check).
      const violation = validateNewSlotAgainstPolicy(record, policy);
      if (violation) {
        return respond({ error: `Authorization violates its policy (${violation}).`, code: violation }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      // 6) The actionId must be exactly the deterministic id of this goal.
      if (record.witness.actionId.toLowerCase() !== delegatedActionId(goalIdRaw).toLowerCase()) {
        return respond({ error: "Authorization is not bound to this goal (actionId mismatch).", code: "ACTION_MISMATCH" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      // 7) The policyHash must be exactly this policy's canonical hash.
      if (record.witness.policyHash.toLowerCase() !== policyHashFor(policy).toLowerCase()) {
        return respond({ error: "Authorization does not match the policy scope (policyHash mismatch).", code: "POLICY_HASH_MISMATCH" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      // 8) CRYPTOGRAPHIC OWNERSHIP: recover the signer from the Permit2
      //    EIP-712 digest and require it to be the authenticated wallet.
      //    This is what makes the slot unforgeable even if every other
      //    check were bypassed. The digest is computed over THIS policy's
      //    chain and THIS chain's pinned executor as the Permit2 spender, so
      //    the recovered signer is bound to (wallet, chain, executor) — not
      //    merely to a wallet.
      const digest = delegatedPermitDigest({ permit: record.permit, witness: record.witness }, policy.chainId, executor);
      const signer = await recoverAddress({ hash: digest, signature: record.signature });
      if (signer.toLowerCase() !== auth.wallet.toLowerCase()) {
        return respond({ error: "Signature does not belong to the authenticated wallet.", code: "SIGNATURE_INVALID" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      records.push(record);
    }

    // 9) Persist — the store's nonce registry refuses reuse atomically.
    await store.slots.saveSlots(records);
    for (const record of records) {
      await store.store.appendAudit(
        {
          at: new Date().toISOString(),
          type: "DELEGATED_AUTHORIZATION_CREATED",
          goalId: record.goalId,
          policyId: record.policyId,
          wallet: auth.wallet,
          data: { slotId: record.id, slotIndex: record.slotIndex, deadline: record.permit.deadline, amountRaw: record.permit.amount, minAmountOutRaw: record.witness.minAmountOut },
        },
        AUTONOMY_LIMITS.maxAuditEventsPerGoal,
      );
    }
    return respond({ slots: records.map((r) => publicSlot(r, nowSeconds)), maxSlots: MAX_DELEGATED_SLOTS }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "duplicate permit nonce") {
      return respond({ error: "This Permit2 nonce was already used. Sign fresh slots.", code: "NONCE_REUSED" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    return unavailable(requestId);
  }
}

export async function DELETE(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = json(requestId);
  if (!isAutonomousAgentEnabled()) return respond({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  // NOTE: no emergency-stop gate here — revocation is the safety control.
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const auth = await requireWallet(request);
  if (!auth) return respond({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!SLOT_ID_RE.test(id)) return respond({ error: "Invalid slot id.", code: "INVALID_SLOT_ID" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  try {
    // markRevoked is wallet-scoped CAS — another wallet's slot reads as not-found.
    const revoked = await system().slots.markRevoked(id, auth.wallet.toLowerCase(), new Date().toISOString());
    if (!revoked) return respond({ error: "Slot not found or already revoked.", code: "SLOT_NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const slot = await system().slots.getSlot(id, auth.wallet.toLowerCase());
    await system().store.appendAudit(
      { at: new Date().toISOString(), type: "DELEGATED_AUTHORIZATION_REVOKED", goalId: slot?.goalId, policyId: slot?.policyId, wallet: auth.wallet, data: { slotId: id } },
      AUTONOMY_LIMITS.maxAuditEventsPerGoal,
    );
    return respond({ revoked: true, slot: slot ? publicSlot(slot, Math.floor(Date.now() / 1000)) : null }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return unavailable(requestId);
  }
}
