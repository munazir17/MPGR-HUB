// lib/trade/trade-risk.ts
//
// Deterministic risk facts for swap / tokenized-stock confirmation UI.
// Built only from known quote + catalog facts — never guessed APY,
// never a fabricated route, never a made-up fee.

import {
  TRADE_DEFAULT_SLIPPAGE_BPS,
} from "./trade-config";
import type {
  CdpSwapQuote,
  TradeKind,
  TradeRiskFact,
  TradeTokenRef,
  TokenizedStockCatalogEntry,
} from "./trade-types";

export function buildSwapRiskFacts(input: {
  kind: TradeKind;
  from: TradeTokenRef;
  to: TradeTokenRef;
  quote: Pick<CdpSwapQuote, "liquidityAvailable" | "issues" | "fees" | "minToAmount" | "toAmount">;
  slippageBps: number;
}): TradeRiskFact[] {
  const facts: TradeRiskFact[] = [];

  if (!input.from.verified) {
    facts.push({
      id: "unverified-from",
      severity: "critical",
      title: "Unverified sell token",
      detail:
        "This sell token is not in MPGR's Base catalog. The address was supplied as a raw 0x value. Confirm it on a block explorer before signing.",
    });
  }
  if (!input.to.verified) {
    facts.push({
      id: "unverified-to",
      severity: "critical",
      title: "Unverified buy token",
      detail:
        "This buy token is not in MPGR's Base catalog. Confirm the contract address before signing.",
    });
  }

  if (!input.quote.liquidityAvailable) {
    facts.push({
      id: "no-liquidity",
      severity: "critical",
      title: "No liquidity",
      detail:
        "Coinbase CDP Trade API reported no available liquidity for this pair on Base. Nothing will be signed.",
    });
  }

  if (input.quote.issues?.simulationIncomplete) {
    facts.push({
      id: "sim-incomplete",
      severity: "warning",
      title: "Incomplete simulation",
      detail:
        "CDP could not fully simulate this swap. The quote may fail on-chain.",
    });
  }

  if (input.quote.issues?.allowance) {
    facts.push({
      id: "permit2-approval",
      severity: "warning",
      title: "Permit2 approval required",
      detail:
        "Your wallet must first approve the canonical Permit2 contract so the swap can pull the sell token. Approval is a separate Base transaction you will sign.",
    });
  }

  if (input.slippageBps > TRADE_DEFAULT_SLIPPAGE_BPS) {
    facts.push({
      id: "high-slippage",
      severity: "warning",
      title: `Slippage ${input.slippageBps / 100}%`,
      detail: `This quote allows up to ${input.slippageBps} bps of price movement. Default protection is ${TRADE_DEFAULT_SLIPPAGE_BPS} bps (1%).`,
    });
  } else {
    facts.push({
      id: "slippage",
      severity: "info",
      title: `Slippage protection ${input.slippageBps / 100}%`,
      detail: `The swap reverts if output falls below the quoted minimum (${input.quote.minToAmount} atomic units).`,
    });
  }

  if (input.kind === "tokenized-stock-swap") {
    facts.push(...tokenizedStockSwapRisk(input.to.kind === "b20-tokenized-stock" ? input.to : input.from));
  }

  facts.push({
    id: "network",
    severity: "info",
    title: "Base Mainnet only",
    detail: "MPGR will not quote or execute this swap on any network other than Base.",
  });

  facts.push({
    id: "provider",
    severity: "info",
    title: "Route via Coinbase CDP Trade API",
    detail:
      "Price, route, and calldata come from Coinbase's documented EVM Swap API. This app does not pick a DEX pool itself and does not invent a router address.",
  });

  return facts;
}

export function tokenizedStockResearchRisk(
  catalog: TokenizedStockCatalogEntry,
): TradeRiskFact[] {
  return [
    {
      id: "not-brokerage-share",
      severity: "warning",
      title: "Tokenized stock, not a brokerage share",
      detail: `${catalog.symbol} is a Coinbase B20 token on Base representing economic exposure to ${catalog.underlyingTicker}. It is not a traditional stock certificate in a brokerage account.`,
    },
    {
      id: "multiplier",
      severity: "warning",
      title: "On-chain multiplier",
      detail:
        "1 token is not permanently 1 share. Corporate actions update an on-chain WAD multiplier. Use the token's scaledBalance helpers for share-equivalent size. Coinbase Chainlink feeds already publish total return (underlying × multiplier) — do not multiply the feed again.",
    },
    {
      id: "ap-only-mint",
      severity: "warning",
      title: "No issuer mint/redeem in this app",
      detail:
        "Primary mint and redeem are Authorized Participant only. MPGR will not call a fake mint API. Secondary buy/sell is a Base DEX swap when CDP reports liquidity.",
    },
    {
      id: "oracle-hours",
      severity: "info",
      title: "Chainlink equity oracle is 24/5",
      detail:
        "The documented reference price is traditional-market (Chainlink), not the DEX price. Feeds freeze during corporate actions and hold last close on weekends.",
    },
    {
      id: "sanctions-policy",
      severity: "info",
      title: "Transfer policies may revert",
      detail:
        "B20 tokens can enforce on-chain policies. A transfer to a blocked address reverts even if an ERC-20 allowance exists.",
    },
  ];
}

function tokenizedStockSwapRisk(token: TradeTokenRef): TradeRiskFact[] {
  return [
    {
      id: "tokenized-swap",
      severity: "warning",
      title: `Swapping ${token.symbol} on Base`,
      detail:
        "This is a DEX swap of a Coinbase tokenized stock (B20), not an issuer subscription. Liquidity can be thin. Price may differ from the Chainlink equity oracle.",
    },
    {
      id: "ap-only-mint-exec",
      severity: "info",
      title: "Not a primary-market purchase",
      detail:
        "Confirming this does not mint a new share from Coinbase. It swaps existing tokens already on Base.",
    },
  ];
}

export function riskToWarnings(facts: readonly TradeRiskFact[]): string[] {
  return facts
    .filter((fact) => fact.severity !== "info")
    .map((fact) => `${fact.title}: ${fact.detail}`);
}
