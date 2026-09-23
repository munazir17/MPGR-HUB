// lib/agent-intelligence/swap-intent.ts
//
// Deterministic parser for naturally-phrased Base swap requests over the
// app's EXISTING supported token universe — no new tokens, no guessed
// contracts.
//
// Why this exists: the original crypto-swap classifiers only understood
// the four core tokens (ETH / WETH / USDC / MPGR). A perfectly normal
// request like "Swap 10 USDC to cbADA" therefore fell straight through
// the deterministic (always-available) provider into generic help text,
// so the swap never reached the quote/prepare path. This parser reads
// the same catalog the swap routes already trust
// (lib/trade/trade-tokens.ts → lib/markets/base-pairs.ts +
// lib/trade/tokenized-stocks.ts), so anything it resolves is already
// swappable and anything else simply does not match — the model/route
// layer still owns the final address decision.
//
// Rules baked in:
//   - a token only matches when it resolves in the existing catalog or
//     is a literal 0x address (raw addresses stay `verified: false`,
//     exactly like the API path that adds its own risk warnings)
//   - sell and buy must resolve to different addresses
//   - "$10" is only an amount in the SELL token's units when the sell
//     side is USDC; otherwise the amount is left null so the agent asks
//     instead of guessing a unit conversion
//   - quote-only phrasing ("quote", "price", "how much") is flagged so
//     callers can answer with a price instead of a proposal

import { resolveTradeToken, type ResolveTradeTokenResult } from "@/lib/trade/trade-tokens";
import type { TradeTokenKind } from "@/lib/trade/trade-types";

export interface BaseSwapIntentSide {
  /** The token text exactly as the user wrote it. */
  input: string;
  /** Canonical allowlisted symbol, or null when the input is a raw address. */
  symbol: string | null;
  /** Checksummed Base address (catalog entry, or the user-supplied 0x). */
  address: string;
  /** True only when the address is in this app's compile-time catalog. */
  verified: boolean;
  decimals: number;
  kind: TradeTokenKind;
}

export interface BaseSwapIntent {
  sell: BaseSwapIntentSide;
  buy: BaseSwapIntentSide;
  /** Human sell amount when the prompt states one; null means "ask". */
  amount: string | null;
  /** True when the amount was written as a $ figure. */
  amountIsDollar: boolean;
  /** True for pure price/quote phrasing — never prepare from these. */
  quoteOnly: boolean;
}

const SYMBOL = "[a-z][a-z0-9]{1,15}";
const TOKEN = `(${SYMBOL}|0x[a-f0-9]{40})`;
const NUMBER = "([0-9]+(?:\\.[0-9]+)?)";

/**
 * "swap 10 USDC to cbADA" / "quote 10 USDC to cbADA" /
 * "convert $5 eth into USDC" / "sell 2 cbBTC for USDC" /
 * "swap $10 of cbBTC to cbADA"
 */
const SWAP_RE = new RegExp(
  "\\b(?:swap|trade|convert|exchange|sell|quote)\\s+" +
    "(?:(?:of|worth|some)\\s+(?:of\\s+)?)?" +
    "(\\$\\s*)?" +
    NUMBER +
    "?" +
    "\\s*(\\$\\s*)?" +
    "(?:(?:of|worth)\\s+(?:of\\s+)?|some\\s+)?" +
    TOKEN +
    "\\s*(?:to|into|for|->|=>|→|/)\\s*" +
    TOKEN,
  "i",
);

/** "buy $10 of cbADA" / "buy 25 cbDOGE" */
const BUY_RE = new RegExp(
  "\\bbuy\\s+(?:of\\s+|some\\s+)?" +
    "(\\$\\s*)?" +
    NUMBER +
    "?" +
    "\\s*(?:\\$\\s*|of\\s+|some\\s+|worth\\s+(?:of\\s+)?)?" +
    TOKEN,
  "i",
);

/**
 * "how much cbBTC do I get for 0.1 ETH" / "what can I get for 1 USDC in cbADA"
 * — quote-only phrasing over the extended universe.
 */
const HOW_MUCH_RE = new RegExp(
  "\\bhow much\\s+(?:of\\s+)?" +
    TOKEN +
    "[\\s\\w,]{0,24}?\\b(?:for|from|with)\\s*" +
    "(\\$\\s*)?" +
    NUMBER +
    "?\\s*(?:of\\s+)?" +
    TOKEN,
  "i",
);

const QUOTE_ONLY_RE = /\bquote\b|\bprice\b|how much|what can i get|spot price/;

function toSide(result: Extract<ResolveTradeTokenResult, { ok: true }>, rawInput: string): BaseSwapIntentSide {
  const token = result.token;
  return {
    input: rawInput.trim(),
    symbol: token.verified ? token.symbol : null,
    address: token.address,
    verified: token.verified,
    decimals: token.decimals,
    kind: token.kind,
  };
}

function resolveSide(rawInput: string): BaseSwapIntentSide | null {
  const cleaned = rawInput.trim().replace(/^\$/, "");
  if (!cleaned) return null;
  // "USD" is the dollar stable the user means on Base; the catalog's
  // native dollar token is USDC, and it is the only dollar entry there.
  const normalized = cleaned.toLowerCase() === "usd" ? "usdc" : cleaned;
  const resolved = resolveTradeToken(normalized);
  if (!resolved.ok) return null;
  return toSide(resolved, cleaned);
}

function buildIntent(
  sellRaw: string,
  buyRaw: string,
  amount: string | null,
  amountIsDollar: boolean,
  prompt: string,
): BaseSwapIntent | null {
  const sell = resolveSide(sellRaw);
  const buy = resolveSide(buyRaw);
  if (!sell || !buy) return null;
  if (sell.address.toLowerCase() === buy.address.toLowerCase()) return null;

  // "$10" means 10 USDC only when USDC is the sell side. For any other
  // sell token a dollar figure is not a token quantity — leave it null
  // so the caller asks for the amount instead of inventing decimals.
  const usableAmount = amountIsDollar && sell.symbol !== "USDC" ? null : amount;
  const numeric = usableAmount !== null && Number(usableAmount) > 0 ? usableAmount : null;

  return {
    sell,
    buy,
    amount: numeric,
    amountIsDollar: amountIsDollar && numeric !== null,
    quoteOnly: QUOTE_ONLY_RE.test(prompt.toLowerCase()),
  };
}

/**
 * Parses a natural-language Base swap request over the existing supported
 * token universe. Returns null when the prompt is not a resolvable swap —
 * callers must fall through to their existing behavior, never guess.
 */
export function extractBaseSwapIntent(prompt: string): BaseSwapIntent | null {
  if (typeof prompt !== "string" || !prompt.trim()) return null;
  const text = prompt.trim();

  const howMuch = text.match(HOW_MUCH_RE);
  if (howMuch) {
    // groups: 1 = buy token, 2 = $ prefix, 3 = number, 4 = sell token
    const buyToken = howMuch[1];
    const amount = howMuch[3] ?? null;
    const sellToken = howMuch[4];
    const intent = buildIntent(sellToken, buyToken, amount, false, text);
    if (intent) return { ...intent, quoteOnly: true };
  }

  const swap = text.match(SWAP_RE);
  if (swap) {
    // groups: 1 = $ before number, 2 = number, 3 = $ after number,
    //         4 = sell token, 5 = buy token
    const dollar = Boolean(swap[1] || swap[3]);
    const intent = buildIntent(swap[4], swap[5], swap[2] ?? null, dollar, text);
    if (intent) return intent;
  }

  const buy = text.match(BUY_RE);
  if (buy) {
    // "buy 25 cbADA" is a USDC-funded buy: the amount is the token
    // quantity; a "$25" figure is a USDC spend.
    // groups: 1 = $ prefix, 2 = number, 3 = buy token
    const intent = buildIntent("USDC", buy[3], buy[2] ?? null, Boolean(buy[1]), text);
    if (intent) return intent;
  }

  return null;
}
