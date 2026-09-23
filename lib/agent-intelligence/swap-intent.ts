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
//   - an execution order with no size still parses (amount: null): the
//     caller asks for the amount instead of silently treating an order as
//     a research question

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

// The link between the sell and buy side. "of" and "worth of" are how
// people write the same request ("sell 5 usdc of eth", "swap 10 USDC
// worth of cbADA"); the arrow/"/" forms are the chip wording.
const LINK = "(?:worth\\s+of|to|into|for|in|of|->|=>|→|/)";

/**
 * "swap 10 USDC to cbADA" / "quote 10 USDC to cbADA" /
 * "convert $5 eth into USDC" / "sell 2 cbBTC for USDC" /
 * "swap $10 of cbBTC to cbADA" / "sell 5 usdc of eth"
 */
const SWAP_RE = new RegExp(
  "\\b(?:swap|trade|convert|exchange|sell|quote)\\s+" +
    // "my"/"our"/"the" and "all/entire" are how people hand over the
    // funding side: "sell MY 5 USDC worth of MSTRc", "swap my 2 usdc for
    // eth". They never carry a size by themselves, so the amount groups
    // below are unchanged.
    "(?:(?:my|our|the)\\s+)?" +
    "(?:(?:all|entire)\\s+(?:of\\s+)?)?" +
    "(?:(?:of|worth|some)\\s+(?:of\\s+)?)?" +
    "(\\$\\s*)?" +
    NUMBER +
    "?" +
    "\\s*(\\$\\s*)?" +
    "(?:(?:of|worth)\\s+(?:of\\s+)?|some\\s+)?" +
    TOKEN +
    "\\s*" +
    LINK +
    "\\s*" +
    TOKEN,
  "i",
);

/**
 * "sell my USDC worth of MSTRc" / "sell all my USDC for cbADA" —
 * an explicit execution order with NO size, so the size is not guessed
 * (the caller asks). The possessive/all prefix is required, which is
 * what keeps this from stealing the amount-bearing forms above.
 */
const SELL_ALL_RE = new RegExp(
  "\\b(?:sell|swap|trade|convert|exchange)\\s+" +
    "(?:(?:all|entire|100%)\\s+(?:of\\s+)?(?:my\\s+|our\\s+)?|(?:my|our)\\s+(?:entire\\s+|whole\\s+)?)" +
    "(\\$\\s*)?" +
    TOKEN +
    "\\s*" +
    LINK +
    "\\s*" +
    TOKEN,
  "i",
);

/**
 * "buy 5 USDC of ETH" / "buy 10 usdc worth of cbada" — the amount is
 * denominated in the FIRST token and the SECOND is what is bought. Two
 * tokens are mandatory, so "buy $25 of cbDOGE" (one token) still falls to
 * BUY_RE below as a USDC-funded buy.
 */
const BUY_FOR_RE = new RegExp(
  "\\bbuy\\s+" +
    "(?:(?:my|our|the)\\s+)?" +
    "(?:of\\s+|some\\s+)?" +
    "(\\$\\s*)?" +
    NUMBER +
    "\\s*(?:\\$\\s*|of\\s+|some\\s+|worth\\s+(?:of\\s+)?)?" +
    TOKEN +
    "\\s*" +
    LINK +
    "\\s*" +
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

export interface UnresolvedSwapOrder {
  /** The raw operand text the user wrote for each side. */
  sell: string;
  buy: string;
  amount: string | null;
  /** The operands this app's catalog could not resolve. */
  unresolved: string[];
}

/**
 * A SIZED order ("buy 10 USDC of FAKECOIN", "sell 5 SCAMCOIN for USDC")
 * whose operands the catalog cannot resolve.
 *
 * This exists so an unsupported token gets an explicit refusal instead of
 * generic help — and, above all, so nothing downstream can ever prepare
 * it: an unknown ticker never becomes an executable contract just because
 * a symbol was supplied. Addresses are NOT reported here: a 0x address
 * is resolvable (unverified) and keeps the existing CDP-quoted path.
 *
 * A digit is required, which is what keeps conversational prompts
 * ("buy me a coffee") and unsized research questions out of this path.
 */
export function extractUnresolvedSwapOrder(prompt: string): UnresolvedSwapOrder | null {
  if (typeof prompt !== "string" || !prompt.trim()) return null;
  const text = prompt.trim();
  if (!/[0-9]/.test(text)) return null;

  const shape = (sell: string, buy: string, amount: string | null, dollar: boolean) => {
    if (buildIntent(sell, buy, amount, dollar, text)) return null;
    const unresolved = [sell, buy].filter((operand) => resolveSide(operand) === null);
    // Both sides resolved (e.g. "swap 10 USDC to USDC") — that is not an
    // unsupported-asset problem, so keep the existing behavior.
    if (unresolved.length === 0) return null;
    return { sell, buy, amount, unresolved };
  };

  const swap = text.match(SWAP_RE);
  if (swap) {
    // groups: 1 = $ before number, 2 = number, 3 = $ after number,
    //         4 = sell token, 5 = buy token
    return shape(swap[4], swap[5], swap[2] ?? null, Boolean(swap[1] || swap[3]));
  }

  const buyFor = text.match(BUY_FOR_RE);
  if (buyFor) {
    // groups: 1 = $ prefix, 2 = number, 3 = amount token, 4 = buy token
    return shape(buyFor[3], buyFor[4], buyFor[2] ?? null, Boolean(buyFor[1]));
  }

  const buy = text.match(BUY_RE);
  if (buy) {
    // groups: 1 = $ prefix, 2 = number, 3 = buy token
    return shape("USDC", buy[3], buy[2] ?? null, Boolean(buy[1]));
  }

  return null;
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

  // An explicit execution order with no size ("sell my USDC worth of
  // MSTRc"): recognized as a swap so the caller asks for the amount and
  // quotes live — never answered as research.
  const sellAll = text.match(SELL_ALL_RE);
  if (sellAll) {
    // groups: 1 = $ prefix (ignored), 2 = sell token, 3 = buy token
    const intent = buildIntent(sellAll[2], sellAll[3], null, false, text);
    if (intent) return intent;
  }

  // "buy 5 USDC of ETH": the number is denominated in the first token.
  const buyFor = text.match(BUY_FOR_RE);
  if (buyFor) {
    // groups: 1 = $ prefix, 2 = number, 3 = amount token, 4 = buy token
    const intent = buildIntent(
      buyFor[3],
      buyFor[4],
      buyFor[2] ?? null,
      Boolean(buyFor[1]),
      text,
    );
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

/**
 * "Sell my 4 USDC worth of MSTRc" / "sell 5 usd worth of AAPLc".
 *
 * The SELL verb governs here: the dollar figure is the VALUE TARGET of
 * the sale (how much USDC the user wants out), and the named stock is
 * what gets sold. Treating the USDC figure as the sell side inverted the
 * order — "Sell my 4 USDC worth of MSTRc" was prepared as "spend 4 USDC
 * to BUY MSTRc", the opposite of what the user asked for.
 *
 * Only this shape flips: the verb must be sell/swap/trade/convert, the
 * amount must be denominated in USDC/USD/dollars, and it must be joined
 * to the operand by "worth of". "buy 5 USDC of MSTRc" (a USDC-funded
 * buy) and "sell 5 USDC of ETH" (a crypto swap pair) keep their existing
 * meaning, and "sell 5 MSTRc" is unaffected.
 */
const SELL_VALUE_TARGET_RE = new RegExp(
  "\\b(?:sell|swap|trade|convert|exchange)\\s+" +
    "(?:(?:my|our|the)\\s+)?" +
    "(?:(?:all|entire)\\s+(?:of\\s+)?)?" +
    "(?:\\$\\s*)?[0-9]+(?:\\.[0-9]+)?" +
    "\\s*(?:\\$\\s*)?" +
    "(?:usdc|usd|dollars?)" +
    "\\s+worth\\s+of\\s+" +
    TOKEN,
  "i",
);

/**
 * True when `rawPrompt` sells `ticker` with a USDC value target
 * ("sell my 4 USDC worth of MSTRc" → SELL MSTRc, ~4 USDC out).
 * The operand after "worth of" must resolve to the same contract as
 * `ticker`, so an unrelated or unsupported name never flips the side.
 */
export function isSellValueTargetPhrasing(rawPrompt: string, ticker: string): boolean {
  if (typeof rawPrompt !== "string" || !rawPrompt.trim() || !ticker) return false;
  const match = rawPrompt.match(SELL_VALUE_TARGET_RE);
  if (!match) return false;

  const target = resolveSide(match[1]);
  const symbol = resolveTradeToken(ticker);
  if (!target || !symbol.ok) return false;
  return target.address.toLowerCase() === symbol.token.address.toLowerCase();
}
