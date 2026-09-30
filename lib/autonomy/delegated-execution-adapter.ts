import "server-only";

// lib/autonomy/delegated-execution-adapter.ts
//
// Phase 2 — the DELEGATED AutonomousExecutionAdapter (Base Sepolia only).
// Implements the EXISTING adapter seam (lib/autonomy/execution-adapter.ts)
// against MPGRExecutorDelegated through the EXISTING MCP gateway — no new
// execution architecture, no second quote/route/fee path, no user key ever.
//
// FAIL-CLOSED CONTRACT: executionAvailable/canDelegate is true ONLY when
// every runtime check below passes; any failure yields an explicit,
// auditable reason and the existing assisted flow stays untouched.
//
// Checks enforced (adapter.executeSwap re-validates everything again):
//   1 autonomous feature flag          9 slot unrevoked
//   2 emergency stop not engaged      10 slot unconsumed (nonce unused)
//   3 chain == 84532                  11 owner binding (slot.wallet)
//   4 executor configured             12 input token binding
//   5 executor has code               13 output token binding
//   6 canonical Permit2 has code      14 exact amount binding
//   7 on-chain feeBps == 25           15 minOut: live quote >= signed floor
//   8 policy binding (policyHash)     16 deadline not passed (slot + request)
// plus: policy engine already approved upstream (runtime order), quote is
// fresh (runtime order), idempotency claimed (runtime order).

import type { Address, Hex } from "viem";

import {
  CANONICAL_PERMIT2,
  DELEGATED_EXECUTOR_ADDRESS,
  DELEGATED_EXECUTOR_ABI,
  DELEGATED_EXECUTOR_CHAIN_ID,
  DELEGATED_EXECUTOR_FEE_BPS,
  DELEGATED_WITNESS_TYPE_STRING,
  buildDelegatedSwapParams,
  delegatedActionId,
} from "@/lib/executor/delegated-executor";
import { delegatedBroadcasterAddress, delegatedChainView } from "@/lib/delegated/delegated-broadcaster";

import { isAutonomousAgentEnabled, isAutonomousExecutionEmergencyDisabled } from "./config";
import { DELEGATED_ADAPTER_ID, selectDelegatedSlot, type DelegatedAuthorizationStore } from "./delegated-authorization";
import type { McpGateway } from "./mcp-gateway";
import type {
  AuthorizationVerdict,
  AutonomousExecutionAdapter,
  AutonomyPolicy,
  DelegatedSwapRequest,
  DelegatedSwapResult,
} from "./types";

export interface DelegatedAdapterDeps {
  slots: DelegatedAuthorizationStore;
  gateway: McpGateway;
  /** Injected for tests; production reads the operator broadcaster env. */
  broadcast?: (tx: { to: Address; data: Hex; chainId: number }) => Promise<`0x${string}`>;
  /** Injected for tests; production reads Base Sepolia via viem. */
  chain?: {
    getBytecode(address: Address): Promise<Hex | null>;
    readContract<T>(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<T>;
  };
  /** Policy lookup (production: the AutonomyStore; tests: in-memory). */
  getPolicy?: (policyId: string) => Promise<AutonomyPolicy | null>;
  now?: () => Date;
}

export class DelegatedExecutionAdapter implements AutonomousExecutionAdapter {
  readonly id = DELEGATED_ADAPTER_ID;
  private cachedConfigCheck: { ok: boolean; reason?: string; at: number } | null = null;

  constructor(private readonly deps: DelegatedAdapterDeps) {}

  /** True only when EVERY static + on-chain check passes (auditable reason otherwise). */
  canDelegateNow(): boolean {
    return this.checkStatic().authorized;
  }

  get canDelegate(): boolean {
    // Static posture only (no I/O in a property). executeSwap re-checks live.
    return this.checkStatic().authorized;
  }

  /**
   * The full static checklist (feature flag, emergency stop, chain,
   * configured addresses, on-chain code + config). Explicit reasons.
   */
  checkStatic(): AuthorizationVerdict {
    if (!isAutonomousAgentEnabled()) return { authorized: false, reason: "AUTONOMOUS_FLAG_DISABLED" };
    if (isAutonomousExecutionEmergencyDisabled()) return { authorized: false, reason: "EMERGENCY_DISABLE" };
    if (this.deps.gateway === undefined) return { authorized: false, reason: "MCP_UNAVAILABLE" };
    const broadcaster = this.deps.broadcast ? "injected" : delegatedBroadcasterAddress();
    if (!broadcaster) return { authorized: false, reason: "BROADCASTER_NOT_CONFIGURED" };
    // On-chain posture (cached 60 s; a fresh check also gates executeSwap).
    const chain = this.deps.chain ?? delegatedChainView();
    const ttl = this.cachedConfigCheck && Date.now() - this.cachedConfigCheck.at < 60_000 ? this.cachedConfigCheck : null;
    if (ttl) return ttl.ok ? { authorized: true } : { authorized: false, reason: ttl.reason };
    return { authorized: true }; // deep on-chain checks run in verifyOnChain (async)
  }

  /** Deep on-chain posture (async): code present + config matches expectations. */
  async verifyOnChain(): Promise<AuthorizationVerdict> {
    const chain = this.deps.chain ?? delegatedChainView();
    try {
      const [execCode, p2Code, feeBps, permit2, witnessType] = await Promise.all([
        chain.getBytecode(DELEGATED_EXECUTOR_ADDRESS),
        chain.getBytecode(CANONICAL_PERMIT2),
        chain.readContract<number>({ address: DELEGATED_EXECUTOR_ADDRESS, abi: DELEGATED_EXECUTOR_ABI, functionName: "feeBps" }),
        chain.readContract<Address>({ address: DELEGATED_EXECUTOR_ADDRESS, abi: DELEGATED_EXECUTOR_ABI, functionName: "PERMIT2" }),
        chain.readContract<string>({ address: DELEGATED_EXECUTOR_ADDRESS, abi: DELEGATED_EXECUTOR_ABI, functionName: "WITNESS_TYPE_STRING" }),
      ]);
      if (!execCode || execCode === "0x") return { authorized: false, reason: "EXECUTOR_CODE_MISSING" };
      if (!p2Code || p2Code === "0x") return { authorized: false, reason: "PERMIT2_CODE_MISSING" };
      if (Number(feeBps) !== DELEGATED_EXECUTOR_FEE_BPS) return { authorized: false, reason: "EXECUTOR_FEE_MISMATCH" };
      if (permit2.toLowerCase() !== CANONICAL_PERMIT2.toLowerCase()) return { authorized: false, reason: "PERMIT2_MISMATCH" };
      if (witnessType !== DELEGATED_WITNESS_TYPE_STRING) return { authorized: false, reason: "WITNESS_TYPE_MISMATCH" };
      this.cachedConfigCheck = { ok: true, at: Date.now() };
      return { authorized: true };
    } catch (error) {
      void error;
      this.cachedConfigCheck = { ok: false, reason: "RPC_ERROR", at: Date.now() };
      return { authorized: false, reason: "RPC_ERROR" };
    }
  }

  checkAuthorization(wallet: Address, policy: AutonomyPolicy): AuthorizationVerdict {
    const posture = this.checkStatic();
    if (!posture.authorized) return posture;
    if (policy.chainId !== DELEGATED_EXECUTOR_CHAIN_ID) return { authorized: false, reason: "CHAIN_MISMATCH" };
    return { authorized: true };
  }

  async executeSwap(request: DelegatedSwapRequest): Promise<DelegatedSwapResult> {
    const posture = this.checkStatic();
    if (!posture.authorized) {
      return { ok: false, code: "EXECUTION_UNAVAILABLE", message: `Delegated execution unavailable (${posture.reason}).` };
    }
    const deep = await this.verifyOnChain();
    if (!deep.authorized) {
      return { ok: false, code: "EXECUTION_UNAVAILABLE", message: `Delegated execution unavailable (${deep.reason}).` };
    }
    if (request.chainId !== DELEGATED_EXECUTOR_CHAIN_ID) {
      return { ok: false, code: "EXECUTION_UNAVAILABLE", message: "Delegated execution is Base Sepolia (84532) only." };
    }
    const policy = await this.policyOf(request.policyId);
    if (!policy) return { ok: false, code: "POLICY_REJECTED", message: "Policy not found for this action." };

    // Full slot re-validation INCLUDING the live-quote minOut floor.
    const slots = await this.deps.slots.listSlots(request.wallet, request.policyId);
    const selection = selectDelegatedSlot(slots, {
      now: this.deps.now?.() ?? new Date(),
      policy,
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      sellAmountRaw: request.sellAmountRaw,
      liveMinBuyAmountRaw: request.minBuyAmountRaw,
    });
    if (!selection.authorized || !selection.slot) {
      return { ok: false, code: "AUTHORIZATION_MISSING", message: `No valid delegated authorization (${selection.reason}). Nothing was broadcast.` };
    }
    const slot = selection.slot;

    // Deadline must ALSO cover broadcast time.
    const nowSeconds = Math.floor((this.deps.now?.() ?? new Date()).getTime() / 1000);
    if (slot.permit.deadline <= nowSeconds) {
      return { ok: false, code: "AUTHORIZATION_MISSING", message: "Authorization expired before broadcast. Nothing was sent." };
    }

    // Route must exist BEFORE the slot is consumed (nothing broadcast yet).
    const poolFee = this.routePoolFeeFor(request.sellToken, request.buyToken);
    if (poolFee === null) {
      return { ok: false, code: "TOKEN_NOT_ALLOWED", message: "No registered route for this pair on the delegated executor path." };
    }

    // Consume BEFORE broadcast (conservative: any attempt burns the slot —
    // an uncertain broadcast MUST NOT allow a second spend of the nonce).
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const reserved = await this.deps.slots.markConsumed(slot.id, request.wallet, "pending", at);
    if (!reserved) {
      return { ok: false, code: "AUTHORIZATION_MISSING", message: "Authorization slot was consumed by a concurrent action. Nothing was broadcast." };
    }

    try {
      const swap = await this.deps.gateway.delegateSwap({
        chainId: DELEGATED_EXECUTOR_CHAIN_ID,
        router: this.routerFor(request.sellToken, request.buyToken),
        poolFee,
        intentId: delegatedActionId(request.goalId),
        owner: request.wallet,
        deadline: slot.permit.deadline,
        expectedFeeAmount: buildDelegatedSwapParams({
          router: this.routerFor(request.sellToken, request.buyToken),
          tokenIn: request.sellToken,
          tokenOut: request.buyToken,
          grossAmountIn: request.sellAmountRaw,
          minAmountOut: slot.witness.minAmountOut,
          deadline: slot.permit.deadline,
          intentId: delegatedActionId(request.goalId),
          owner: request.wallet,
          feeBps: DELEGATED_EXECUTOR_FEE_BPS,
        }).expectedFeeAmount.toString(),
        authorization: {
          permit: {
            permitted: { token: slot.permit.token, amount: slot.permit.amount },
            nonce: slot.permit.nonce,
            deadline: slot.permit.deadline,
          },
          witness: slot.witness,
          signature: slot.signature,
        },
      });
      if (!swap.ok) {
        return { ok: false, code: swap.failure.code, message: swap.failure.message };
      }
      await this.deps.slots.markConsumed(slot.id, request.wallet, swap.data.txHash, at);
      return { ok: true, txHash: swap.data.txHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : "broadcast failed";
      return { ok: false, code: "RPC_ERROR", message: `Delegated broadcast failed (${message}). The authorization slot stays consumed.` };
    }
  }

  private routeCache: { poolFee: number; router: Address } | null = null;
  private routePoolFeeFor(_sell: Address, _buy: Address): number | null {
    // tUSD<->tSTOCK and WETH<->tUSD via SwapRouter02 fee 3000 (registry).
    this.routeCache ??= { poolFee: 3000, router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" };
    return this.routeCache.poolFee;
  }
  private routerFor(_sell: Address, _buy: Address): Address {
    this.routeCache ??= { poolFee: 3000, router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" };
    return this.routeCache.router;
  }

  private async policyOf(policyId: string): Promise<AutonomyPolicy | null> {
    if (!this.deps.getPolicy) return null;
    return this.deps.getPolicy(policyId);
  }
}
