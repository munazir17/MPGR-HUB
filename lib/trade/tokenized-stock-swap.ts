import "server-only";

// lib/trade/tokenized-stock-swap.ts
//
// Public MPGR Agent path for Coinbase Tokenized Stocks on Base (B20).
// Buy/sell is an on-chain Base swap into the user's connected wallet,
// routed through Aerodrome Slipstream USDC pools (see trade-swap-router).
//
// This is NOT Coinbase for Agents / Advanced Trade. That product trades
// custodial S&P 500 cash equities (AAPL-USD) in a Coinbase brokerage
// account and does not mint or transfer B20 tokens (AAPLc) on Base.
// Base docs: holding + secondary-market DEX trading is permissionless;
// issuer mint/redeem is Authorized Participant only.
// CDP Trade API / 0x reject B20 — they are not used on this path.

import { BASE_USDC } from "./trade-config";
import { parseHumanTokenAmount } from "./trade-format";
import { buildTradeProposal } from "./trade-proposal";
import { createRoutedSwapQuote } from "./trade-swap-router";
import { findTokenizedStock } from "./tokenized-stocks";
import { readTokenizedStockOnchain } from "./tokenized-stocks-onchain";
import { resolveTradeToken } from "./trade-tokens";
import type { TradeError, TradeProposal } from "./trade-types";

export type TokenizedStockSwapOutcome =
  | { ok: true; proposal: TradeProposal }
  | { ok: false; error: TradeError };

function parsePositiveDecimal(raw: string): number | null {
  const amount = Number(raw.trim().replace(/^\$/, "").replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

export async function prepareTokenizedStockSwap(input: {
  symbol: string;
  side: "BUY" | "SELL";
  amountHuman: string;
  taker: string;
  slippageBps?: number;
}): Promise<TokenizedStockSwapOutcome> {
  // SECURITY: reject signed/negative dollar amounts before any
  // catalog lookup, quote generation, or execution preparation.
  // The raw tool input must preserve the user's original sign;
  // never allow an LLM normalization such as "-$2" -> "$2" to
  // become a valid trade.
  const rawAmount = input.amountHuman.trim();
  const normalizedAmount = rawAmount.replace(/,/g, "").replace(/^\$/, "");
  if (
    /^-/.test(normalizedAmount) ||
    /^\$-/.test(rawAmount) ||
    /^\+/.test(normalizedAmount)
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Trade amount must be a positive dollar amount.",
      },
    };
  }

  const catalog = findTokenizedStock(input.symbol);
  if (!catalog) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_ASSET",
        message: `"${input.symbol}" is not in the official Coinbase B20 catalog on Base.`,
      },
    };
  }

  const usd = parsePositiveDecimal(input.amountHuman);
  if (usd === null) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: `"${input.amountHuman}" is not a valid dollar amount.` },
    };
  }

  const usdc = resolveTradeToken("USDC");
  const stock = resolveTradeToken(catalog.ticker);
  if (!usdc.ok || !stock.ok) {
    return {
      ok: false,
      error: { code: "UNSUPPORTED_ASSET", message: "Could not resolve USDC or this B20 token." },
    };
  }

  // SAFETY: never trust a hardcoded decimals guess for a B20 token —
  // read it live on-chain and fail closed if it cannot be verified.
  // A wrong decimals value here is a real-funds unit error (e.g. a
  // catalog default of 18 against an actual value of 8 is a 10^10x
  // amount error), so this always runs for both BUY and SELL, not
  // just when the token-amount math needs it.
  const onchain = await readTokenizedStockOnchain(catalog);
  if (onchain.decimals === null) {
    return {
      ok: false,
      error: {
        code: "PROVIDER_ERROR",
        message: `Could not verify ${catalog.ticker}'s on-chain decimals — refusing to guess for a real-funds trade. Try again shortly.`,
      },
    };
  }
  // B20 pause is a real, on-chain transfer-level flag (not a generic
  // ERC-20 assumption — this reads the actual IB20 `paused()` state
  // already fetched above). If it's paused, transfers on this token
  // would revert on-chain, so execution must not proceed even if a
  // route/quote could otherwise be built.
  if (onchain.paused === true) {
    return {
      ok: false,
      error: {
        code: "LIQUIDITY_UNAVAILABLE",
        message: `${catalog.ticker} transfers are currently paused on-chain. No trade can proceed while paused.`,
      },
    };
  }

  if (onchain.totalSupply === "0") {
    return {
      ok: false,
      error: {
        code: "LIQUIDITY_UNAVAILABLE",
        message: `${catalog.ticker} has not been issued on Base yet, so no executable secondary-market trade is available.`,
      },
    };
  }
  const verifiedStockToken = { ...stock.token, decimals: onchain.decimals };

  let from = usdc.token;
  let to = verifiedStockToken;
  let fromAmount: bigint;

  if (input.side === "BUY") {
    const parsed = parseHumanTokenAmount(String(usd), usdc.token.decimals);
    if (parsed === null) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Could not convert that dollar amount to USDC units." } };
    }
    fromAmount = parsed;
  } else {
    const px = onchain.impliedTokenPriceUsd ? Number(onchain.impliedTokenPriceUsd) : NaN;
    if (!Number.isFinite(px) || px <= 0) {
      return {
        ok: false,
        error: {
        code: "LIQUIDITY_UNAVAILABLE",
          message: `No live Chainlink price for ${catalog.ticker}, so a $-denominated sell size cannot be converted to tokens.`,
        },
      };
    }
    const tokenHuman = usd / px;
    const parsed = parseHumanTokenAmount(String(tokenHuman), verifiedStockToken.decimals);
    if (parsed === null || parsed <= 0n) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Could not convert that dollar amount into a B20 token size." },
      };
    }
    from = verifiedStockToken;
    to = usdc.token;
    fromAmount = parsed;
  }

  const quote = await createRoutedSwapQuote({
    fromToken: from.address,
    toToken: to.address,
    fromAmount: fromAmount.toString(),
    taker: input.taker,
    slippageBps: input.slippageBps,
  });
  if (!quote.ok) return quote;

  const proposal = buildTradeProposal({
    from,
    to,
    quote: quote.value,
    slippageBps: input.slippageBps ?? 100,
    taker: input.taker,
    provider: quote.provider,
  });
  if (!proposal.ok) return proposal;
  return { ok: true, proposal: proposal.proposal };
}

export function usdcAddress(): string {
  return BASE_USDC;
}
