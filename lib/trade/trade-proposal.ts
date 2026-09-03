// lib/trade/trade-proposal.ts
//
// Builds a TradeProposal from a CDP quote + resolved tokens.
// Never signs, never broadcasts. Transaction calldata is carried for
// the confirmation/execution layer only — the chat model never sees it.

import { getAddress, isAddress, type Address } from "viem";

import {
  CDP_TRADE_PROVIDER_ID,
  CDP_TRADE_PROVIDER_LABEL,
  PERMIT2_ADDRESS,
  TRADE_CHAIN_ID,
  TRADE_NETWORK,
  TRADE_QUOTE_MAX_AGE_MS,
} from "./trade-config";
import { formatAtomicAmount } from "./trade-format";
import { buildSwapRiskFacts, riskToWarnings } from "./trade-risk";
import { isTokenizedStockToken, type TradeTokenRef } from "./trade-tokens";
import type {
  CdpSwapIssues,
  CdpSwapQuote,
  TradeError,
  TradeKind,
  TradeProposal,
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

  const needsPermit2Approval = issues.allowance !== null;
  const permit2Spender = issues.allowance?.spender
    ? checksum(issues.allowance.spender)
    : needsPermit2Approval
      ? PERMIT2_ADDRESS
      : null;

  const postConfirmationSteps = executionAvailable
    ? [
        ...(needsPermit2Approval
          ? ["Your wallet will first approve Permit2 to spend the sell token."]
          : []),
        ...(input.quote.permit2
          ? ["Your wallet will sign a one-time Permit2 authorization for this swap only."]
          : []),
        "Your wallet will sign the Coinbase CDP swap transaction on Base.",
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
      provider: CDP_TRADE_PROVIDER_ID,
      providerLabel: CDP_TRADE_PROVIDER_LABEL,
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
      needsPermit2Approval,
      permit2Spender,
      risk,
      warnings: riskToWarnings(risk),
      displayFromAmount: `${displayFrom} ${input.from.symbol}`,
      displayToAmount: `~${displayTo} ${input.to.symbol}`,
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
