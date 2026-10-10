import "server-only";

// lib/autonomy/delegated-execution-adapter.ts
//
// The DELEGATED AutonomousExecutionAdapter (Base Sepolia 84532 + Base mainnet
// 8453). Implements the EXISTING adapter seam (lib/autonomy/execution-adapter.ts)
// against MPGRExecutorDelegated through the EXISTING MCP gateway — no new
// execution architecture, no second quote/route/fee path, no user key ever.
//
// ONE CLASS, TWO INSTANCES. The chain is a constructor argument, so the
// mainnet path reuses the identical safety machinery rather than forking it.
// The adapter DECLARES its chain (`chainId`) so the runtime never infers a
// chain from an id string.
//
// FAIL-CLOSED CONTRACT: executionAvailable/canDelegate is true ONLY when every
// runtime check below passes; any failure yields an explicit, auditable reason
// and the existing assisted flow stays untouched. On Base mainnet the checks
// are STRICTER than on Sepolia, because the mainnet executor address is
// operator-supplied rather than code-pinned.
//
// Checks enforced (adapter.executeSwap re-validates everything again):
//   1 autonomous feature flag          9 slot unrevoked
//   2 emergency stop not engaged      10 slot unconsumed (nonce unused)
//   3 PRODUCTION GATE — mainnet only: 11 owner binding (slot.wallet)
//     AUTONOMOUS_PRODUCTION_ENABLED   12 input token binding
//   4 chain == this adapter's chain   13 output token binding
//   5 executor pinned + has code      14 exact amount binding
//   6 canonical Permit2 has code      15 minOut: live quote >= signed floor
//   7 on-chain feeBps == 25           16 deadline not passed (slot + request)
//   8 witness type string exact + policy binding (policyHash)
//  mainnet only: owner/feeRecipient governance match, not paused, and both
//  policy tokens on the executor's own allowlist.
// plus: policy engine already approved upstream (runtime order), quote is
// fresh (runtime order), idempotency claimed (runtime order).

import { keccak256, type Address, type Hex } from "viem";

import {
  CANONICAL_PERMIT2,
  DELEGATED_EXECUTOR_ABI,
  DELEGATED_EXECUTOR_FEE_BPS,
  DELEGATED_EXECUTOR_REQUIRED_FEE_RECIPIENT,
  DELEGATED_EXECUTOR_REQUIRED_OWNER,
  DELEGATED_WITNESS_TYPE_STRING,
  buildDelegatedSwapParams,
  delegatedActionId,
  delegatedChainLabel,
  delegatedExecutorAddressFor,
  delegatedExecutorDeploymentFor,
  isDelegatedChainId,
} from "@/lib/executor/delegated-executor";
import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, RouterKind, findExecutorRoute, type RouterKindValue } from "@/lib/executor/executor-config";
import {
  delegatedBroadcasterAddress,
  delegatedChainView,
  mainnetBroadcasterAddress,
  mainnetDelegatedChainView,
} from "@/lib/delegated/delegated-broadcaster";

import { isAutonomousAgentEnabled, isAutonomousExecutionEmergencyDisabled, isAutonomousProductionEnabled } from "./config";
import { logEmergencySwitchDecision, readAutonomousEmergencySwitch } from "./emergency-switch";
import { DELEGATED_ADAPTER_ID, selectDelegatedSlot, type DelegatedAuthorizationStore } from "./delegated-authorization";
import type { McpGateway } from "./mcp-gateway";
import {
  delegatedAdapterIdForChain,
  type AuthorizationVerdict,
  type AutonomousExecutionAdapter,
  type AutonomyPolicy,
  type DelegatedSwapRequest,
  type DelegatedSwapResult,
} from "./types";

/** How long a proven on-chain posture stays trusted before re-verification. */
export const DELEGATED_POSTURE_TTL_MS = 60_000;

export interface DelegatedAdapterDeps {
  slots: DelegatedAuthorizationStore;
  gateway: McpGateway;
  /** Injected for tests; production reads the operator broadcaster env. */
  broadcast?: (tx: { to: Address; data: Hex; chainId: number; value?: bigint }) => Promise<`0x${string}`>;
  /** Injected for tests; production reads the chain via viem. */
  chain?: {
    getBytecode(address: Address): Promise<Hex | null>;
    readContract<T>(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<T>;
  };
  /** Policy lookup (production: the AutonomyStore; tests: in-memory). */
  getPolicy?: (policyId: string) => Promise<AutonomyPolicy | null>;
  now?: () => Date;
  /** The chain this adapter serves. Defaults to Base Sepolia (84532). */
  chainId?: number;
}

/** A resolved execution venue for a pair on this adapter's chain. */
interface ResolvedRoute {
  kind: RouterKindValue;
  router: Address;
  poolFee: number | null;
  tickSpacing: number | null;
}

export class DelegatedExecutionAdapter implements AutonomousExecutionAdapter {
  /** The chain this adapter executes on — declared, never inferred from `id`. */
  readonly chainId: number;
  readonly id: string;

  private cachedConfigCheck: { ok: boolean; reason?: string; at: number } | null = null;
  private warmInFlight: Promise<AuthorizationVerdict> | null = null;
  private routeCache: ResolvedRoute | null = null;

  constructor(private readonly deps: DelegatedAdapterDeps) {
    const chainId = deps.chainId ?? BASE_SEPOLIA_CHAIN_ID;
    if (!isDelegatedChainId(chainId)) throw new Error(`DelegatedExecutionAdapter: unsupported chain ${chainId}`);
    this.chainId = chainId;
    this.id = delegatedAdapterIdForChain(chainId) ?? DELEGATED_ADAPTER_ID;
  }

  /** Human label for this adapter's chain, used in refusal messages. */
  get chainLabel(): string {
    return delegatedChainLabel(this.chainId);
  }

  /** The pinned delegated executor for this chain, or null when unpinned. */
  get executor(): Address | null {
    return delegatedExecutorAddressFor(this.chainId);
  }

  /** True only when EVERY static + on-chain check passes (auditable reason otherwise). */
  canDelegateNow(): boolean {
    return this.checkStatic().authorized;
  }

  get canDelegate(): boolean {
    // Static posture only (no I/O in a property). executeSwap re-checks live.
    return this.checkStatic().authorized;
  }

  /**
   * Operational posture only (no chain I/O): feature flag, emergency stop,
   * gateway + THIS CHAIN'S broadcaster configuration. Explicit auditable reasons.
   *
   * The broadcaster is resolved per chain: a testnet key never satisfies a
   * mainnet adapter and vice versa, and on mainnet the forbidden canary key
   * resolves to null (see lib/delegated/delegated-broadcaster.ts).
   */
  private checkOperational(): AuthorizationVerdict {
    if (!isAutonomousAgentEnabled()) return { authorized: false, reason: "AUTONOMOUS_FLAG_DISABLED" };
    if (isAutonomousExecutionEmergencyDisabled()) return { authorized: false, reason: "EMERGENCY_DISABLE" };
    // EXPLICIT PRODUCTION GATE (Base mainnet only). AUTONOMOUS_PRODUCTION_ENABLED
    // must be the exact string "true" in the deployment env before ANY mainnet
    // delegated execution is even considered; missing/false/malformed fails
    // closed with an auditable reason. Observation (quotes/conditions) is
    // unaffected — goals stay watch-only. Base Sepolia is not gated: it is a
    // testnet with no production value, and gating it would only push testing
    // toward mainnet.
    if (this.chainId === BASE_MAINNET_CHAIN_ID && !isAutonomousProductionEnabled()) {
      return { authorized: false, reason: "PRODUCTION_GATE_DISABLED" };
    }
    if (this.deps.gateway === undefined) return { authorized: false, reason: "MCP_UNAVAILABLE" };
    if (!this.executor) return { authorized: false, reason: "EXECUTOR_NOT_CONFIGURED" };
    const broadcaster = this.deps.broadcast
      ? "injected"
      : this.chainId === BASE_MAINNET_CHAIN_ID
        ? mainnetBroadcasterAddress()
        : delegatedBroadcasterAddress();
    if (!broadcaster) return { authorized: false, reason: "BROADCASTER_NOT_CONFIGURED" };
    return { authorized: true };
  }

  /**
   * Static checklist = operational posture + on-chain posture. FAIL-CLOSED on a
   * cold/stale chain-check cache: until a verifyOnChain() pass proves the
   * deployed configuration, the answer is ONCHAIN_CHECK_PENDING, never an
   * optimistic true.
   *
   * MC-3 FIX (cold-cache chicken-and-egg): a cold cache no longer dead-ends.
   * This still reports PENDING for the CURRENT tick — no optimism, no execution
   * — but it also kicks a single-flight background warm-up, so the posture is
   * proven by the time the next tick evaluates. Previously the cache could only
   * ever be warmed by executeSwap(), which the runtime only reaches AFTER
   * checkAuthorization() said yes: an unreachable state on a cold server.
   */
  checkStatic(): AuthorizationVerdict {
    const operational = this.checkOperational();
    if (!operational.authorized) return operational;
    const fresh = this.cachedConfigCheck && Date.now() - this.cachedConfigCheck.at < DELEGATED_POSTURE_TTL_MS ? this.cachedConfigCheck : null;
    if (!fresh) {
      this.warmPosture();
      return { authorized: false, reason: "ONCHAIN_CHECK_PENDING" };
    }
    return fresh.ok ? { authorized: true } : { authorized: false, reason: fresh.reason };
  }

  /**
   * Kick a single-flight background posture warm-up. Never blocks the caller
   * and never throws: verifyOnChain() records its own failure verdict.
   */
  warmPosture(): void {
    if (this.warmInFlight) return;
    const pending = this.verifyOnChain().finally(() => {
      this.warmInFlight = null;
    });
    this.warmInFlight = pending;
    pending.catch(() => {
      /* verifyOnChain never rejects; belt-and-braces so a rejection can't escape */
    });
  }

  /**
   * Eager posture bootstrap for startup/cron wiring. Awaits the in-flight
   * warm-up when one exists, so concurrent callers share a single RPC pass.
   *
   * Safe to call on every tick: it is single-flight, TTL-cached, and a failure
   * leaves the adapter refused rather than optimistic.
   */
  async bootstrapPosture(policy?: AutonomyPolicy): Promise<AuthorizationVerdict> {
    if (this.warmInFlight) return this.warmInFlight;
    const pending = this.verifyOnChain(policy).finally(() => {
      this.warmInFlight = null;
    });
    this.warmInFlight = pending;
    return pending;
  }

  /**
   * Deep on-chain posture (async): code present + config matches expectations.
   *
   * On BASE MAINNET the checks are deliberately stricter, because the executor
   * address there is operator-supplied (MPGR_MAINNET_DELEGATED_EXECUTOR) rather
   * than code-pinned: it must additionally match the MPGR governance owner and
   * fee recipient, must not be paused, and (when a policy is supplied) both
   * policy tokens must be on the contract's own allowlist. An arbitrary or
   * hostile address therefore can never pass.
   *
   * Base Sepolia keeps its original check set exactly, so existing behaviour
   * and tests are unchanged.
   */
  async verifyOnChain(policy?: AutonomyPolicy): Promise<AuthorizationVerdict> {
    const executor = this.executor;
    if (!executor) {
      this.cachedConfigCheck = { ok: false, reason: "EXECUTOR_NOT_CONFIGURED", at: Date.now() };
      return { authorized: false, reason: "EXECUTOR_NOT_CONFIGURED" };
    }
    const chain = this.deps.chain ?? (this.chainId === BASE_MAINNET_CHAIN_ID ? mainnetDelegatedChainView() : delegatedChainView());
    const refuse = (reason: string): AuthorizationVerdict => {
      this.cachedConfigCheck = { ok: false, reason, at: Date.now() };
      return { authorized: false, reason };
    };
    try {
      const [execCode, p2Code, feeBps, permit2, witnessType] = await Promise.all([
        chain.getBytecode(executor),
        chain.getBytecode(CANONICAL_PERMIT2),
        chain.readContract<number>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "feeBps" }),
        chain.readContract<Address>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "PERMIT2" }),
        chain.readContract<string>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "WITNESS_TYPE_STRING" }),
      ]);
      if (!execCode || execCode === "0x") return refuse("EXECUTOR_CODE_MISSING");
      if (!p2Code || p2Code === "0x") return refuse("PERMIT2_CODE_MISSING");
      if (Number(feeBps) !== DELEGATED_EXECUTOR_FEE_BPS) return refuse("EXECUTOR_FEE_MISMATCH");
      if (permit2.toLowerCase() !== CANONICAL_PERMIT2.toLowerCase()) return refuse("PERMIT2_MISMATCH");
      if (witnessType !== DELEGATED_WITNESS_TYPE_STRING) return refuse("WITNESS_TYPE_MISMATCH");

      if (this.chainId === BASE_MAINNET_CHAIN_ID) {
        const [owner, feeRecipient, paused] = await Promise.all([
          chain.readContract<Address>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "owner" }),
          chain.readContract<Address>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "feeRecipient" }),
          chain.readContract<boolean>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "paused" }),
        ]);
        if (owner.toLowerCase() !== DELEGATED_EXECUTOR_REQUIRED_OWNER.toLowerCase()) return refuse("EXECUTOR_OWNER_MISMATCH");
        if (feeRecipient.toLowerCase() !== DELEGATED_EXECUTOR_REQUIRED_FEE_RECIPIENT.toLowerCase()) return refuse("EXECUTOR_FEE_RECIPIENT_MISMATCH");
        if (paused) return refuse("EXECUTOR_PAUSED");
        if (policy) {
          const [sellAllowed, buyAllowed] = await Promise.all([
            chain.readContract<boolean>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "isTokenAllowed", args: [policy.sellToken] }),
            chain.readContract<boolean>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "isTokenAllowed", args: [policy.buyToken] }),
          ]);
          if (!sellAllowed || !buyAllowed) return refuse("TOKEN_NOT_ALLOWED");

          const deployment = delegatedExecutorDeploymentFor(this.chainId);
          const route = deployment ? findExecutorRoute(deployment, policy.sellToken, policy.buyToken) : null;
          if (route?.kind === RouterKind.TYPED_SWAP_MODULE) {
            if (!route.moduleAddress || !route.moduleCodeHash) return refuse("SWAP_MODULE_CONFIG_MISSING");
            const [kind, module, codeHash, moduleCode] = await Promise.all([
              chain.readContract<number>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "routerKind", args: [route.router] }),
              chain.readContract<Address>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "swapModuleForRouter", args: [route.router] }),
              chain.readContract<Hex>({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "swapModuleCodeHash", args: [route.router] }),
              chain.getBytecode(route.moduleAddress),
            ]);
            if (
              Number(kind) !== RouterKind.TYPED_SWAP_MODULE
                || module.toLowerCase() !== route.moduleAddress.toLowerCase()
                || codeHash.toLowerCase() !== route.moduleCodeHash.toLowerCase()
                || !moduleCode
                || moduleCode === "0x"
                || keccak256(moduleCode).toLowerCase() !== route.moduleCodeHash.toLowerCase()
            ) return refuse("SWAP_MODULE_POSTURE_MISMATCH");
          }
        }
      }

      this.cachedConfigCheck = { ok: true, at: Date.now() };
      return { authorized: true };
    } catch (error) {
      void error;
      return refuse("RPC_ERROR");
    }
  }

  checkAuthorization(wallet: Address, policy: AutonomyPolicy): AuthorizationVerdict {
    void wallet;
    const posture = this.checkStatic();
    if (!posture.authorized) return posture;
    // The policy must target THIS adapter's chain. Combined with the slot-level
    // chain binding in delegated-authorization.ts and the chain inside the
    // signed Permit2 domain + policyHash, a cross-chain policy can never be
    // executed by this adapter.
    if (policy.chainId !== this.chainId) return { authorized: false, reason: "CHAIN_MISMATCH" };
    return { authorized: true };
  }

  async executeSwap(request: DelegatedSwapRequest): Promise<DelegatedSwapResult> {
    // Authoritative KV emergency switch at the execution boundary (uncached).
    // Fail-closed: missing/malformed/unavailable KV refuses before any slot
    // is consumed or any broadcast is attempted.
    const emergency = await readAutonomousEmergencySwitch();
    if (!emergency.allowed) {
      logEmergencySwitchDecision({ warn: () => {}, debug: () => {} }, emergency, { adapter: this.id });
      return {
        ok: false,
        code: "EXECUTION_UNAVAILABLE",
        message: `Delegated execution unavailable (${emergency.reason}).`,
      };
    }
    // Operational gates first (no I/O), then the LIVE on-chain check —
    // which also refreshes the cache checkStatic() reports from.
    const posture = this.checkOperational();
    if (!posture.authorized) {
      return { ok: false, code: "EXECUTION_UNAVAILABLE", message: `Delegated execution unavailable (${posture.reason}).` };
    }
    if (request.chainId !== this.chainId) {
      return {
        ok: false,
        code: "EXECUTION_UNAVAILABLE",
        message: `This adapter executes on ${this.chainLabel} (${this.chainId}) only; the request asked for chain ${request.chainId}.`,
      };
    }
    const policy = await this.policyOf(request.policyId);
    if (!policy) return { ok: false, code: "POLICY_REJECTED", message: "Policy not found for this action." };
    // The live check is policy-aware on mainnet so the token allowlist is
    // verified against the ACTUAL pair before anything is consumed or sent.
    const deep = await this.verifyOnChain(policy);
    if (!deep.authorized) {
      return { ok: false, code: "EXECUTION_UNAVAILABLE", message: `Delegated execution unavailable (${deep.reason}).` };
    }

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

    // The slot must be bound to THIS chain (selectDelegatedSlot already enforces
    // slot.chainId === policy.chainId; re-asserted here as a local invariant).
    if (slot.chainId !== this.chainId) {
      return { ok: false, code: "AUTHORIZATION_MISSING", message: `Authorization is bound to chain ${slot.chainId}, not ${this.chainId}. Nothing was broadcast.` };
    }

    // Deadline must ALSO cover broadcast time.
    const nowSeconds = Math.floor((this.deps.now?.() ?? new Date()).getTime() / 1000);
    if (slot.permit.deadline <= nowSeconds) {
      return { ok: false, code: "AUTHORIZATION_MISSING", message: "Authorization expired before broadcast. Nothing was sent." };
    }

    // Route must exist BEFORE the slot is consumed (nothing broadcast yet).
    const route = this.resolveRoute(request.sellToken, request.buyToken);
    if (!route) {
      return { ok: false, code: "TOKEN_NOT_ALLOWED", message: `No registered route for this pair on the ${this.chainLabel} delegated executor path.` };
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
        chainId: this.chainId,
        executor: this.executor ?? undefined,
        router: route.router,
        ...(route.tickSpacing !== null ? { tickSpacing: route.tickSpacing } : {}),
        ...(route.poolFee !== null ? { poolFee: route.poolFee } : {}),
        intentId: delegatedActionId(request.goalId),
        owner: request.wallet,
        // MCP service parses numeric authorization fields from digit STRINGS
        // (its only wire format; the value is identical — pure serialization).
        deadline: String(slot.permit.deadline),
        expectedFeeAmount: buildDelegatedSwapParams({
          router: route.router,
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
            deadline: String(slot.permit.deadline),
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

  /**
   * Resolve the execution venue for a pair on this chain.
   *
   * Base Sepolia keeps its original pinned venue (tUSD<->tSTOCK and
   * WETH<->tUSD via SwapRouter02 fee 3000) so existing behaviour is unchanged.
   * Base mainnet resolves from the chain's OWN delegated registry, which
   * mirrors the deployed v1 routes: USDC<->WETH on Uniswap V3 fee 3000, and
   * USDC<->each B20 stock on Aerodrome Slipstream tickSpacing 10. The caller
   * can never choose the router.
   */
  private resolveRoute(sell: Address, buy: Address): ResolvedRoute | null {
    if (this.chainId === BASE_SEPOLIA_CHAIN_ID) {
      this.routeCache ??= { kind: RouterKind.UNISWAP_V3_ROUTER02, router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4", poolFee: 3000, tickSpacing: null };
      return this.routeCache;
    }
    const deployment = delegatedExecutorDeploymentFor(BASE_MAINNET_CHAIN_ID);
    if (!deployment) return null;
    const route = findExecutorRoute(deployment, sell, buy);
    if (!route) return null;
    return {
      kind: route.kind,
      router: route.router,
      poolFee: route.kind === RouterKind.UNISWAP_V3_ROUTER02 ? route.poolFee ?? null : null,
      tickSpacing: route.kind === RouterKind.AERODROME_SLIPSTREAM ? route.tickSpacing ?? null : null,
    };
  }

  private async policyOf(policyId: string): Promise<AutonomyPolicy | null> {
    if (!this.deps.getPolicy) return null;
    return this.deps.getPolicy(policyId);
  }
}
