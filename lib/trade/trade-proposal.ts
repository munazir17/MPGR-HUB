// lib/trade/trade-proposal.ts
//
// Builds a TradeProposal from a CDP quote + resolved tokens.
// Never signs, never broadcasts. Transaction calldata is carried for
// the confirmation/execution layer only — the chat model never sees it.

import { getAddress, isAddress, type Address } from "viem";

import {
  CDP_TRADE_PROVIDER_ID,
  PERMIT2_ADDRESS,
  TRADE_CHAIN_ID,
  TRADE_NETWORK,
  TRADE_QUOTE_MAX_AGE_MS,
  ZERO_EX_PROVIDER_ID,
  tradeProviderLabel,
} from "./trade-config";
import { formatAtomicAmount } from "./trade-format";
import { buildSwapRiskFacts, riskToWarnings } from "./trade-risk";
import { isTokenizedStockToken } from "./trade-tokens";
import type {
  CdpSwapIssues,
  CdpSwapQuote,
  TradeError,
  TradeKind,
  TradeProposal,
  TradeProvider,
  TradeTokenRef,
} from "./trade-types";
export type BuildTradeProposalResult =
  | { ok: true; proposal: TradeProposal }
  | { ok: false; error: TradeError };

export interface BuildTradeProposalInput {
  from: TradeTokenRef;
  to: TradeTokenRef;
  quote: CdpSwapQuote;
  slippageBps: number;
  taker: string;
  quotedAt?: Date;
  provider?: TradeProvider;
}

function checksum(address: string): Address {
  try {
    return getAddress(address);
  } catch {
    return address as Address;
  }
}

function emptyIssues(): CdpSwapIssues {
  return { allowance: null, balance: null, simulationIncomplete: false };
}

function buildDeterministicId(input: {
  from: string;
  to: string;
  fromAmount: string;
  taker: string;
  slippageBps: number;
}): string {
  return [
    "trade",
    input.taker.toLowerCase(),
    input.from.toLowerCase(),
    input.to.toLowerCase(),
    input.fromAmount,
    String(input.slippageBps),
  ].join("_");
}

export function buildTradeProposal(
  input: BuildTradeProposalInput,
): BuildTradeProposalResult {
  if (!isAddress(input.taker)) {
    return {
      ok: false,
      error: { code: "WALLET_REQUIRED", message: "A connected Base wallet is required to prepare this swap." },
    };
  }
  if (input.from.address.toLowerCase() === input.to.address.toLowerCase()) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "Sell token and buy token must be different." },
    };
  }

  const kind: TradeKind =
    isTokenizedStockToken(input.from) || isTokenizedStockToken(input.to)
      ? "tokenized-stock-swap"
      : "swap";

  const issues = input.quote.issues ?? emptyIssues();
  const quotedAt = input.quotedAt ?? new Date();
  const expiresAt = new Date(quotedAt.getTime() + TRADE_QUOTE_MAX_AGE_MS);
  const liquidityAvailable = input.quote.liquidityAvailable === true;
  const executionAvailable =
    liquidityAvailable && input.quote.transaction !== null;

  const risk = buildSwapRiskFacts({
    kind,
    from: input.from,
    to: input.to,
    quote: input.quote,
    slippageBps: input.slippageBps,
  });

  const displayFrom = formatAtomicAmount(input.quote.fromAmount, input.from.decimals);
  const displayTo = formatAtomicAmount(input.quote.toAmount, input.to.decimals);
  const displayMin = formatAtomicAmount(input.quote.minToAmount, input.to.decimals);

  // Terminology depends on which flow actually happened, not on the
  // presence of an allowance issue alone: CDP Trade API uses Permit2
  // (a signed EIP-712 authorization, no on-chain approve tx), while
  // the 0x Swap API AllowanceHolder route uses a plain ERC-20
  // approve() to the AllowanceHolder contract — calling that
  // "Permit2" is factually wrong and was flagged in review. Only the
  // presence of `input.quote.permit2` means an actual Permit2 flow is
  // happening; an allowance issue with no permit2 object means a
  // standard token-spending approval instead.
  const provider = input.provider ?? CDP_TRADE_PROVIDER_ID;
  const isZeroExAllowanceHolder = provider === ZERO_EX_PROVIDER_ID;
  const needsAllowanceApproval = issues.allowance !== null;
  const hasPermit2Flow = input.quote.permit2 !== null;
  const permit2Spender = issues.allowance?.spender
    ? checksum(issues.allowance.spender)
    : needsAllowanceApproval
      ? PERMIT2_ADDRESS
      : null;

  const postConfirmationSteps = executionAvailable
    ? [
        ...(needsAllowanceApproval && !hasPermit2Flow
          ? [
              isZeroExAllowanceHolder
                ? "Your wallet will first approve token spending for the 0x AllowanceHolder contract."
                : "Your wallet will first approve token spending for this swap.",
            ]
          : []),
        ...(hasPermit2Flow
          ? ["Your wallet will sign a one-time Permit2 authorization for this swap only."]
          : []),
        "Your wallet will sign the swap transaction on Base.",
        "Nothing broadcasts until you approve each wallet prompt.",
      ]
    : [
        "No executable route is available. Review the research and risk facts — nothing will be signed.",
      ];

  const description = executionAvailable
    ? `Swap ${displayFrom} ${input.from.symbol} → ~${displayTo} ${input.to.symbol} on Base (min ${displayMin} ${input.to.symbol}).`
    : `No executable Base swap is available for ${input.from.symbol} → ${input.to.symbol} right now.`;

  return {
    ok: true,
    proposal: {
      id: buildDeterministicId({
        from: input.from.address,
        to: input.to.address,
        fromAmount: input.quote.fromAmount,
        taker: input.taker,
        slippageBps: input.slippageBps,
      }),
      kind,
      network: TRADE_NETWORK,
      chainId: TRADE_CHAIN_ID as 8453,
      provider: input.provider ?? CDP_TRADE_PROVIDER_ID,
      providerLabel: tradeProviderLabel(input.provider ?? CDP_TRADE_PROVIDER_ID),
      from: input.from,
      to: input.to,
      fromAmount: input.quote.fromAmount,
      toAmount: input.quote.toAmount,
      minToAmount: input.quote.minToAmount,
      slippageBps: input.slippageBps,
      taker: checksum(input.taker),
      liquidityAvailable,
      executionAvailable,
      quotedAt: quotedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      fees: input.quote.fees ?? {},
      issues,
      transaction: input.quote.transaction,
      permit2: input.quote.permit2,
      // Field name kept for API/type stability (TradeProposal.needsPermit2Approval
      // is the existing wire contract); the VALUE and the user-facing wording
      // above are what actually needed fixing for 0x/AllowanceHolder swaps.
      needsPermit2Approval: needsAllowanceApproval,
      permit2Spender,
      risk,
      warnings: riskToWarnings(risk),
      displayFromAmount: `${displayFrom} ${input.from.symbol}`,
      displayToAmount: `\~${displayTo} ${input.to.symbol}`,
      displayMinToAmount: `${displayMin} ${input.to.symbol}`,
      description,
      postConfirmationSteps,
      requiresConfirmation: true,
      phase: "idle",
    },
  };
}

export function isTradeQuoteFresh(proposal: TradeProposal, now = Date.now()): boolean {
  const quotedAt = Date.parse(proposal.quotedAt);
  if (!Number.isFinite(quotedAt)) return false;
  return now - quotedAt <= TRADE_QUOTE_MAX_AGE_MS;
}
