import "server-only";

// lib/trade/trade-executor-quote.ts
//
// The app's swap quote for pairs the MPGR Executor can route. This is the
// ONLY browser-facing path that charges the MPGR Agent fee, and it charges
// it the intended way: inside the swap transaction.
//
//   user wallet ──grossAmountIn (+ approval when short)──▶ MPGRExecutor
//     executor ──fee = floor(gross * feeBps / 10_000)──▶ executor feeRecipient
//     executor ──(gross - fee)──▶ allowlisted router ──▶ output to the taker
//
// Consequences that are structurally guaranteed here:
//   - The transaction the wallet signs is `to: executor` — never a router,
//     never the fee recipient.
//   - The gross sell amount is fee-aware: the pool is quoted for
//     `gross - fee`, and `expectedFeeAmount` is committed in calldata so
//     the contract reverts (FeeMismatch) if the on-chain fee changed.
//   - The fee recipient is the executor's configured `feeRecipient()`
//     (read live), and is never the connected wallet.
//   - No fee transfer is built anywhere: there is no transfer in this
//     flow at all. First-time ERC-20 = approve + swap; afterwards = swap.
//
// Pairs without a proven executor route return `{ ok: false, supported: false }`
// so the caller keeps its existing provider (CDP / 0x / Aerodrome) — that
// route is quoted with NO fee (see lib/trade/trade-agent-fee.ts).
//
// Read-only: nothing here signs, sends, or holds a key.

import { type Address } from "viem";

import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_EXECUTOR_DEPLOYMENT,
  findExecutorRoute,
  findExecutorToken,
  RouterKind,
  type ExecutorDeployment,
} from "@/lib/executor/executor-config";
import {
  createChainReader,
  quoteSlipstream,
  quoteUniswapV3,
  readAllowance,
  readExecutorLiveConfig,
  readTokenBalance,
  type ChainReader,
} from "@/lib/executor/executor-chain";
import { computeExecutorFee } from "@/lib/executor/executor-fee";
import {
  approvalAuthorization,
  buildExecutorIntent,
  encodeExecutorSwap,
  intentIdFromQuoteId,
} from "@/lib/executor/executor-intent";
import { isNativeEthSentinel, MPGR_EXECUTOR_PROVIDER_ID, TRADE_CHAIN_ID } from "./trade-config";
import { buildExecutorAgentFee } from "./trade-agent-fee";
import { buildTradeProposal, tradeProposalId } from "./trade-proposal";
import type { CdpSwapIssues, CdpSwapQuote, TradeAgentFee, TradeError, TradeProposal, TradeTokenRef } from "./trade-types";

export type ExecutorQuoteResult =
  /** The pair has a proven executor route and the proposal is ready to confirm. */
  | { ok: true; proposal: TradeProposal }
  /** No proven executor route for this pair — the caller keeps its existing provider. */
  | { ok: false; supported: false }
  /** Executor route exists but the quote could not be built — never fall back silently. */
  | { ok: false; supported: true; error: TradeError };

export interface ExecutorQuoteInput {
  from: TradeTokenRef;
  to: TradeTokenRef;
  /** GROSS sell amount in atomic units (fee included). */
  fromAmount: string;
  taker: string;
  slippageBps: number;
  quotedAt?: Date;
  priceImpactBps?: number | null;
  /** Test seam: inject a ChainReader instead of dialing Base. */
  reader?: ChainReader;
  /** Test seam: override the registered deployment. */
  deployment?: ExecutorDeployment;
  nowSeconds?: number;
}

const WETH = (deployment: ExecutorDeployment): Address => deployment.weth;

/** True when this pair is routable through the MPGR Executor (pure, no RPC). */
export function isExecutorRoutablePair(
  fromAddress: string,
  toAddress: string,
  deployment: ExecutorDeployment = BASE_MAINNET_EXECUTOR_DEPLOYMENT,
): boolean {
  const sell = isNativeEthSentinel(fromAddress) ? WETH(deployment) : fromAddress;
  const buy = isNativeEthSentinel(toAddress) ? WETH(deployment) : toAddress;
  if (!findExecutorToken(deployment, sell) || !findExecutorToken(deployment, buy)) return false;
  return findExecutorRoute(deployment, sell, buy) !== null;
}

function intentCodeToTradeError(code: string, message: string): TradeError {
  switch (code) {
    case "NO_ROUTE":
    case "TOKEN_NOT_ALLOWED":
      return { code: "LIQUIDITY_UNAVAILABLE", message };
    case "TAKER_IS_FEE_RECIPIENT":
    case "INVALID_FEE_RECIPIENT":
    case "INVALID_TAKER":
      return {
        code: "EXECUTION_UNAVAILABLE",
        message:
          "This wallet cannot trade through the MPGR Executor right now (fee configuration). No fee was charged and nothing was signed.",
      };
    case "INVALID_SLIPPAGE":
    case "INVALID_DEADLINE":
    case "INVALID_ROUTE":
    case "SAME_TOKEN":
    case "NATIVE_REQUIRES_WETH":
    case "NATIVE_REQUIRES_APPROVAL_MODE":
      return { code: "INVALID_INPUT", message };
    case "NO_LIQUIDITY":
    case "ZERO_MIN_OUTPUT":
      return { code: "LIQUIDITY_UNAVAILABLE", message };
    default:
      return { code: "PROVIDER_ERROR", message };
  }
}

/**
 * Builds the confirmable executor proposal for a supported pair, or reports
 * that the pair is not executor-supported / the quote failed. Read-only.
 */
export async function buildExecutorSwapProposal(input: ExecutorQuoteInput): Promise<ExecutorQuoteResult> {
  const deployment = input.deployment ?? BASE_MAINNET_EXECUTOR_DEPLOYMENT;
  if (deployment.chainId !== TRADE_CHAIN_ID || deployment.chainId !== BASE_MAINNET_CHAIN_ID) {
    return { ok: false, supported: false };
  }

  const sellNative = isNativeEthSentinel(input.from.address);
  const buyNative = isNativeEthSentinel(input.to.address);
  const sellAddress = sellNative ? WETH(deployment) : input.from.address;
  const buyAddress = buyNative ? WETH(deployment) : input.to.address;

  // Unknown token/route → this is simply not an executor pair. Pure check,
  // no RPC: unsupported pairs must not pay for a network round trip.
  if (!findExecutorToken(deployment, sellAddress) || !findExecutorToken(deployment, buyAddress)) {
    return { ok: false, supported: false };
  }
  const route = findExecutorRoute(deployment, sellAddress, buyAddress);
  if (!route) return { ok: false, supported: false };

  let grossAmountIn: bigint;
  try {
    grossAmountIn = BigInt(input.fromAmount);
  } catch {
    return { ok: false, supported: true, error: { code: "INVALID_INPUT", message: "Sell amount must be a positive integer in atomic units." } };
  }
  if (grossAmountIn <= 0n) {
    return { ok: false, supported: true, error: { code: "INVALID_INPUT", message: "Sell amount must be greater than zero." } };
  }

  const reader = input.reader ?? createChainReader(BASE_MAINNET_CHAIN_ID);

  let live: Awaited<ReturnType<typeof readExecutorLiveConfig>>;
  try {
    live = await readExecutorLiveConfig(reader, deployment.executor);
  } catch {
    return {
      ok: false,
      supported: true,
      error: { code: "PROVIDER_ERROR", message: "The MPGR Executor could not be read on Base. Nothing was signed." },
    };
  }
  if (live.paused) {
    return {
      ok: false,
      supported: true,
      error: { code: "EXECUTION_UNAVAILABLE", message: "The MPGR Executor is paused on Base. Nothing was signed." },
    };
  }

  // Fee-aware gross split — the same integer math as MPGRExecutor._begin.
  const fee = computeExecutorFee(grossAmountIn, live.feeBps);
  if (!fee.ok) {
    return {
      ok: false,
      supported: true,
      error: { code: "INVALID_INPUT", message: "Sell amount is too small for the MPGR fee to be at least one base unit." },
    };
  }

  // Pool quote for the POST-fee amount: the executor swaps gross - fee.
  let expectedBuyAmount: bigint;
  try {
    expectedBuyAmount =
      route.kind === RouterKind.UNISWAP_V3_ROUTER02
        ? await quoteUniswapV3(reader, route.quoter, sellAddress, buyAddress, fee.value.swapAmountIn, route.poolFee as number)
        : await quoteSlipstream(reader, route.quoter, sellAddress, buyAddress, fee.value.swapAmountIn, route.tickSpacing as number);
  } catch {
    return {
      ok: false,
      supported: true,
      error: { code: "PROVIDER_ERROR", message: "The Executor's Base pool quote could not be read. Nothing was signed." },
    };
  }
  if (expectedBuyAmount <= 0n) {
    return {
      ok: false,
      supported: true,
      error: { code: "LIQUIDITY_UNAVAILABLE", message: "No executable Base liquidity route is available for this pair." },
    };
  }

  // The live feeBps is authoritative. With the production value (25 bps) the
  // fee is always applied; the 0-bps branch exists only so an owner-configured
  // fee-free period quotes honestly instead of being refused.
  let agentFee: { fee: TradeAgentFee } | null = null;
  if (live.feeBps !== 0) {
    const built = buildExecutorAgentFee({
      grossAmountIn: grossAmountIn.toString(),
      feeBps: live.feeBps,
      feeRecipient: live.feeRecipient,
      from: input.from,
      taker: input.taker,
    });
    if (!built.ok) {
      // With a non-zero on-chain feeBps the executor swap ALWAYS carries its
      // fee: quoting one without it would revert (FeeRoundsToZero /
      // TakerIsFeeRecipient).
      return {
        ok: false,
        supported: true,
        error: { code: "EXECUTION_UNAVAILABLE", message: "This swap cannot carry the MPGR Executor fee. Nothing was signed." },
      };
    }
    agentFee = { fee: built.fee };
  }

  const proposalId = tradeProposalId({
    from: input.from.address,
    to: input.to.address,
    fromAmount: grossAmountIn.toString(),
    taker: input.taker,
    slippageBps: input.slippageBps,
  });

  const intent = buildExecutorIntent({
    deployment,
    taker: input.taker,
    sellToken: sellAddress,
    buyToken: buyAddress,
    sellNative,
    buyNative,
    sellAmount: grossAmountIn,
    expectedBuyAmount,
    slippageBps: input.slippageBps,
    authorization: "APPROVAL",
    nowSeconds: input.nowSeconds ?? Math.floor(Date.now() / 1000),
    quoteId: proposalId,
    feeBps: live.feeBps,
    feeRecipient: live.feeRecipient,
  });
  if (!intent.ok) {
    return { ok: false, supported: true, error: intentCodeToTradeError(intent.error.code, intent.error.message) };
  }

  const transaction = encodeExecutorSwap(intent.value, approvalAuthorization());

  // Approval is a SEPARATE transaction only when the standing allowance to
  // the executor is short — and it is always for the GROSS amount, because
  // the executor pulls gross and forwards the fee itself.
  let allowanceIssue: CdpSwapIssues["allowance"] = null;
  if (!sellNative) {
    try {
      const allowance = await readAllowance(reader, sellAddress, input.taker as Address, deployment.executor);
      if (allowance < grossAmountIn) {
        allowanceIssue = { currentAllowance: allowance.toString(), spender: deployment.executor };
      }
    } catch {
      // Fail closed toward showing the approval step: an unnecessary
      // approve() is cheaper than an on-chain revert.
      allowanceIssue = { currentAllowance: "0", spender: deployment.executor };
    }
  }

  let balanceIssue: CdpSwapIssues["balance"] = null;
  try {
    const balance = sellNative
      ? await reader.getBalance({ address: input.taker as Address })
      : await readTokenBalance(reader, sellAddress, input.taker as Address);
    if (balance < grossAmountIn) {
      balanceIssue = {
        token: sellAddress,
        currentBalance: balance.toString(),
        requiredBalance: grossAmountIn.toString(),
      };
    }
  } catch {
    balanceIssue = null; // live re-read before signing still guards this.
  }

  const quote: CdpSwapQuote = {
    liquidityAvailable: true,
    fromToken: input.from.address,
    toToken: input.to.address,
    fromAmount: grossAmountIn.toString(),
    toAmount: intent.value.expectedBuyAmount,
    minToAmount: intent.value.minBuyAmount,
    fees: {},
    issues: { allowance: allowanceIssue, balance: balanceIssue, simulationIncomplete: false },
    // The wallet signs ONE transaction: this one, to the MPGR Executor.
    transaction: { to: transaction.to, data: transaction.data, value: transaction.value },
    permit2: null, // APPROVAL auth: a plain ERC-20 approve, no EIP-712 signature
  };

  const built = buildTradeProposal({
    from: input.from,
    to: input.to,
    quote,
    slippageBps: input.slippageBps,
    taker: input.taker,
    provider: MPGR_EXECUTOR_PROVIDER_ID,
    quotedAt: input.quotedAt,
    priceImpactBps: input.priceImpactBps,
    ...(agentFee ? { agentFee: agentFee.fee } : {}),
  });
  if (!built.ok) return { ok: false, supported: true, error: built.error };

  // Defence in depth: an applied fee must belong to an executor transaction.
  if (built.proposal.transaction?.to.toLowerCase() !== deployment.executor.toLowerCase()) {
    return {
      ok: false,
      supported: true,
      error: { code: "EXECUTION_UNAVAILABLE", message: "The MPGR Executor route could not be prepared. Nothing was signed." },
    };
  }

  return { ok: true, proposal: built.proposal };
}

/** Exported for tests/fixtures: the deterministic executor intent id of a proposal. */
export function executorIntentId(proposalId: string): `0x${string}` {
  return intentIdFromQuoteId(proposalId);
}
