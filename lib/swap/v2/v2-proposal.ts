// lib/swap/v2/v2-proposal.ts
// Adapts an ACTIVATED /api/swap/v2/quote response into the app's shared
// TradeProposal, so the existing execution engine (approval flow, permit2
// handling, wallet preflight, receipt waiting, activity history and proof UI)
// works for V2 without forking it.
//
// Client-safe on purpose: pure adaptation and arithmetic over an already-fetched
// JSON response. No I/O, no secrets.
//
// Fail-closed by design. A dormant response (executable:false, transaction:null)
// yields `null`, never a proposal — so the caller falls back to V1 exactly as it
// does today. Any missing, malformed or internally inconsistent field also
// yields null rather than a partially-formed signable proposal.
import { keccak256, type Address, Hex } from "viem";
import { formatAtomicAmount } from "@/lib/trade/trade-format";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { V2_FEE_BPS, V2_FEE_RECIPIENT } from "./discovery";
import { swapV2Executor } from "./deployment";
import type { SwapV2Entry, SwapV2RoutingEvidence } from "./v2-evidence";
import { SWAP_V2_MAX_HOPS, SWAP_V2_MAX_LEGS } from "./v2-evidence";

export interface SwapV2QuoteLeg {
  pools: readonly { pool: Address; kind: number; router: Address }[];
  tokens: readonly Address[];
  amountIn: string;
  amountOut: string;
}

/** The activated response shape. Every bigint arrives as a decimal string
 * because the route JSON-serialises bigints explicitly. */
export interface SwapV2QuoteResponse {
  quote?: {
    tokenIn?: string; tokenOut?: string; gross?: string; feeBps?: number;
    feeRecipient?: string; fee?: string; net?: string; amountOut?: string;
    legs?: readonly SwapV2QuoteLeg[];
  };
  blockNumber?: string;
  blockHash?: string;
  preview?: boolean;
  executable?: boolean;
  executionSimulation?: string;
  transaction?: { to?: string; data?: string; value?: string } | null;
  executor?: string; spender?: string; chainId?: number; intentId?: string;
  entry?: string; minToAmount?: string; toAmount?: string; fee?: string;
  feeBps?: number; feeRecipient?: string; slippageBps?: number; deadline?: string;
  nativeIn?: boolean; nativeOut?: boolean; hops?: number; settlementNote?: string;
}

const ATOMIC = /^\d+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH32 = /^0x[0-9a-f]{64}$/i;
const DATA = /^0x[0-9a-fA-F]*$/;

/** True when the response carries an executable V2 transaction. A dormant
 * preview response is deliberately NOT executable, so this is the single place
 * that decides whether V2 or V1 serves the user. */
export function isExecutableSwapV2Response(value: unknown): value is SwapV2QuoteResponse {
  if (!value || typeof value !== "object") return false;
  const r = value as SwapV2QuoteResponse;
  return r.executable === true && r.preview === false && !!r.transaction &&
    typeof r.transaction.to === "string" && typeof r.transaction.data === "string";
}

export interface SwapV2ProposalContext {
  from: TradeTokenRef;
  to: TradeTokenRef;
  taker: Address;
  slippageBps: number;
  /** Moment the response was received; the proposal's clock is never renewed. */
  quotedAt: number;
}

/** Builds a TradeProposal from an activated V2 response, or null if anything is
 * missing or inconsistent. Never fabricates an amount, a fee or a deadline. */
export function swapV2ProposalFromResponse(
  response: SwapV2QuoteResponse,
  ctx: SwapV2ProposalContext,
): TradeProposal | null {
  try {
    const deployment = swapV2Executor();
    // Dormant, or a response that is not from the activated gate: no proposal.
    if (deployment === null) return null;
    if (!isExecutableSwapV2Response(response)) return null;
    const tx = response.transaction!;
    const q = response.quote;
    if (!q) return null;

    if (typeof tx.to !== "string" || tx.to.toLowerCase() !== deployment.executor.toLowerCase()) return null;
    if (typeof tx.data !== "string" || !DATA.test(tx.data) || tx.data.length < 10) return null;
    if (typeof tx.value !== "string" || !ATOMIC.test(tx.value)) return null;
    if (typeof response.executor !== "string" || response.executor.toLowerCase() !== deployment.executor.toLowerCase()) return null;
    // BUY and SELL agree: the approval spender is the executor the tx targets.
    if (typeof response.spender !== "string" || response.spender.toLowerCase() !== tx.to.toLowerCase()) return null;
    if (response.chainId !== 8453) return null;

    if (typeof q.gross !== "string" || !ATOMIC.test(q.gross) || q.gross === "0") return null;
    if (typeof response.toAmount !== "string" || !ATOMIC.test(response.toAmount) || response.toAmount === "0") return null;
    if (typeof response.minToAmount !== "string" || !ATOMIC.test(response.minToAmount) || response.minToAmount === "0") return null;
    if (typeof response.fee !== "string" || !ATOMIC.test(response.fee)) return null;
    if (typeof response.intentId !== "string" || !HASH32.test(response.intentId)) return null;
    if (typeof response.deadline !== "string" || !ATOMIC.test(response.deadline) || response.deadline === "0") return null;
    if (typeof response.blockNumber !== "string" || !ATOMIC.test(response.blockNumber)) return null;
    if (typeof response.blockHash !== "string" || !HASH32.test(response.blockHash)) return null;
    if (response.executionSimulation !== "eth-call-succeeded-no-settlement-proof") return null;
    if (typeof response.settlementNote !== "string" || response.settlementNote.length === 0) return null;
    if (response.entry !== "swapExactInput" && response.entry !== "swapExactInputSplit") return null;

    const gross = BigInt(q.gross);
    const toAmount = BigInt(response.toAmount);
    const minToAmount = BigInt(response.minToAmount);
    const fee = BigInt(response.fee);
    const deadline = BigInt(response.deadline);

    // The 25 bps fee invariant, recomputed here rather than trusted: floor on
    // GROSS, collected once, to the pinned treasury.
    if (response.feeBps !== V2_FEE_BPS || q.feeBps !== V2_FEE_BPS) return null;
    if (fee !== (gross * BigInt(V2_FEE_BPS)) / 10_000n || fee <= 0n || fee >= gross) return null;
    if (typeof response.feeRecipient !== "string" || response.feeRecipient.toLowerCase() !== V2_FEE_RECIPIENT.toLowerCase()) return null;
    if (typeof q.feeRecipient !== "string" || q.feeRecipient.toLowerCase() !== V2_FEE_RECIPIENT.toLowerCase()) return null;
    if (typeof q.net !== "string" || BigInt(q.net) !== gross - fee) return null;
    if (typeof q.fee !== "string" || BigInt(q.fee) !== fee) return null;

    // Minimum must be exactly the quoted output less the selected slippage — the
    // same integer rule swapQuotePolicyError enforces, checked before it runs.
    if (!Number.isInteger(ctx.slippageBps) || ctx.slippageBps <= 0 || ctx.slippageBps > 10_000) return null;
    if (response.slippageBps !== ctx.slippageBps) return null;
    if (minToAmount !== (toAmount * BigInt(10_000 - ctx.slippageBps)) / 10_000n) return null;
    if (minToAmount > toAmount) return null;

    // Native value must equal gross on a native sell, and be zero otherwise.
    const nativeIn = response.nativeIn === true;
    const nativeOut = response.nativeOut === true;
    if (BigInt(tx.value) !== (nativeIn ? gross : 0n)) return null;
    // The server's native flags must agree with the tokens the user actually
    // picked. Downstream policy derives "is this a native sell?" from the token
    // ADDRESS (the native sentinel), not from this flag, so a disagreement would
    // produce a proposal whose value policy later rejects at signing time. Fail
    // here instead, where the reason is still intelligible.
    if (nativeIn !== isNativeEthSentinel(ctx.from.address)) return null;
    if (nativeOut !== isNativeEthSentinel(ctx.to.address)) return null;

    // Array.isArray() widens a readonly tuple to any[]; re-assert the element
    // type so the pool/amount arithmetic below stays checked.
    const legs = (Array.isArray(q.legs) ? q.legs : null) as readonly SwapV2QuoteLeg[] | null;
    if (!legs || legs.length < 1 || legs.length > SWAP_V2_MAX_LEGS) return null;
    if (response.entry === "swapExactInputSplit" && legs.length < 2) return null;
    if (response.entry === "swapExactInput" && legs.length !== 1) return null;
    const legHops = legs.map((l) => (Array.isArray(l.pools) ? l.pools.length : 0));
    if (legHops.some((h) => !Number.isInteger(h) || h < 1 || h > SWAP_V2_MAX_HOPS)) return null;
    if (typeof response.hops !== "number" || response.hops !== legHops[0]) return null;
    const pools = legs.flatMap((l) => l.pools.map((p) => p.pool));
    if (pools.some((p) => typeof p !== "string" || !ADDRESS.test(p) || BigInt(p) === 0n)) return null;
    if (new Set(pools.map((p) => p.toLowerCase())).size !== pools.length) return null;
    // Legs must allocate exactly the net amount: the fee is taken once, on gross.
    if (legs.reduce((sum, l) => sum + BigInt(l.amountIn), 0n) !== gross - fee) return null;
    if (legs.reduce((sum, l) => sum + BigInt(l.amountOut), 0n) !== toAmount) return null;

    const expiresMs = Number(deadline) * 1000;
    if (!Number.isFinite(expiresMs) || expiresMs <= ctx.quotedAt) return null;

    const evidence: SwapV2RoutingEvidence = {
      version: 1,
      intentId: response.intentId as Hex,
      entry: response.entry as SwapV2Entry,
      hops: response.hops,
      legs: legs.length,
      pools,
      legHops,
      blockNumber: response.blockNumber,
      blockHash: response.blockHash as Hex,
      calldataHash: keccak256(tx.data as Hex),
      executionSimulation: "eth-call-succeeded-no-settlement-proof",
      settlementNote: response.settlementNote,
    };

    const display = (atomic: string, token: TradeTokenRef) =>
      formatAtomicAmount(atomic, token.decimals, token.decimals);

    const proposal: TradeProposal = {
      id: `mpgr-swap-v2:${response.intentId}`,
      kind: "swap",
      network: "base",
      chainId: 8453,
      provider: "mpgr-executor",
      providerLabel: `MPGR Executor V2 · ${response.entry === "swapExactInputSplit" ? `${legs.length}-way split` : `${response.hops}-hop`} · Base`,
      from: ctx.from,
      to: ctx.to,
      fromAmount: q.gross,
      toAmount: response.toAmount,
      minToAmount: response.minToAmount,
      slippageBps: ctx.slippageBps,
      taker: ctx.taker,
      liquidityAvailable: true,
      executionAvailable: true,
      quotedAt: new Date(ctx.quotedAt).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      fees: {},
      agentFee: {
        status: "applied",
        bps: V2_FEE_BPS,
        recipient: V2_FEE_RECIPIENT,
        amountAtomic: response.fee,
        displayAmount: `${display(response.fee, ctx.from)} ${ctx.from.symbol}`,
        reason: null,
        collection: "mpgr-executor",
      },
      priceImpactBps: null,
      issues: { allowance: null, balance: null, simulationIncomplete: false },
      transaction: { to: tx.to as Address, data: tx.data as Hex, value: tx.value },
      // No Permit2 on the V2 path: a plain ERC-20 approval to the executor, or
      // nothing at all when the sell side is native ETH.
      permit2: null,
      needsPermit2Approval: !nativeIn,
      permit2Spender: (!nativeIn ? tx.to : null) as Address | null,
      risk: [],
      warnings: [],
      displayFromAmount: display(q.gross, ctx.from),
      displayToAmount: display(response.toAmount, ctx.to),
      displayMinToAmount: display(response.minToAmount, ctx.to),
      description: `Swap ${display(q.gross, ctx.from)} ${ctx.from.symbol} for at least ${display(response.minToAmount, ctx.to)} ${ctx.to.symbol} through the MPGR V2 executor, including the ${V2_FEE_BPS / 100}% MPGR fee taken inside the same transaction.`,
      postConfirmationSteps: [
        nativeIn ? "Native ETH is sent with the swap; no token approval is needed." : "Approve the MPGR V2 executor to spend the exact pay amount.",
        "Confirm the swap; the executor routes it and takes the 0.25% fee in the same transaction.",
        "Settlement is verified from the receipt against the committed minimum and the actual fee event.",
      ],
      requiresConfirmation: true,
      phase: "idle",
    };
    // Attach the evidence the same way V1 attaches `swapPathRouting`.
    return Object.assign(proposal, { swapV2Routing: evidence }) as TradeProposal;
  } catch {
    // Any parsing or arithmetic failure means no proposal: never a partial one.
    return null;
  }
}

