// lib/autonomy/chat-draft.ts
//
// Deterministic detection of AUTONOMOUS trade phrasing (spec §20) and the
// goal draft it produces. Pure module — used by the deterministic AI
// provider so a chat message like
//
//   "Buy AAPLc whenever it falls below 200 USDC, max 20 USDC per trade"
//
// gets an explanation + a REVIEW-ONLY draft. Nothing is ever activated by
// chat text alone: authorization requires an explicit, authenticated POST
// to the autonomy API (the UI's "review & authorize" step).
//
// Scope discipline (spec §25): the matcher is intentionally NARROW — it
// only fires on clearly recurring/conditional phrasing. A plain
// "Swap 1 USDC to AAPLc" never matches, so today's assisted flow is
// byte-for-byte unchanged.

export interface AutonomyGoalDraft {
  /** Buy side of the goal ("AAPLc" for "Buy AAPLc when below $200"). */
  targetAsset: string;
  /** Sell side / spend currency ("USDC" unless the prompt says otherwise). */
  spendAsset: string;
  side: "buy" | "sell";
  triggerKind: "price_below" | "price_above";
  /** Decimal string of the trigger price (buy-token units per sell unit... display only). */
  triggerPrice: string;
  /** Human decimal amount per trade in spend-asset units. */
  amountPerTrade: string | null;
  /** Raw prompt for reference (UI display only). */
  sourcePrompt: string;
}

const TRIGGER_BELOW = /\b(?:when|whenever|if|once|each time|every time)\b[^.?!]{0,80}?\b(?:falls?|drops?|goes|go|dips?|gets?)\s+(?:to|below|under)\b/i;
const TRIGGER_BELOW_ALT = /\b(?:falls?|drops?|dips?)\s+below\b/i;
const TRIGGER_ABOVE = /\b(?:when|whenever|if|once|each time|every time)\b[^.?!]{0,80}?\b(?:rises?|rally|goes|go|climbs?|gets?)\s+(?:to|above|over|past)\b/i;
const TRIGGER_ABOVE_ALT = /\b(?:rises?|climbs?)\s+(?:above|over|past)\b/i;
const RECURRING = /\b(?:whenever|each time|every time|repeatedly|recurring|keep buying|keep selling|automatically|daily)\b/i;
const PRICE_POINT = /\$\s*(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*(?:usd|usdc)\b/i;
const AMOUNT = /\bmax(?:imum)?\b[^.?!]{0,20}?\$?\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\s*(?:per|each)\s*trade|\$?\s*(\d+(?:\.\d+)?)\s*(?:per|each)\s*trade|\b(?:buy|sell|spend|invest)\s+\$?\s*(\d+(?:\.\d+)?)(?=\b)/i;

export interface AutonomyRequestMatch {
  triggerKind: "price_below" | "price_above";
  triggerPrice: string;
  targetAsset: string;
  spendAsset: string;
  amountPerTrade: string | null;
}

/**
 * Returns a match ONLY when the prompt is unambiguously autonomous:
 * a trigger phrase ("when it falls below X") possibly plus recurring
 * phrasing. A one-shot swap request ("swap 1 USDC to AAPLc") never matches.
 */
export function detectAutonomousTradeRequest(prompt: string): AutonomyRequestMatch | null {
  if (!prompt || prompt.length > 400) return null;
  const text = prompt.trim();
  if (text.length < 12) return null;

  const below = TRIGGER_BELOW.test(text) || TRIGGER_BELOW_ALT.test(text);
  const above = TRIGGER_ABOVE.test(text) || TRIGGER_ABOVE_ALT.test(text);
  if (!below && !above) return null;

  // A bare trigger ("buy when it falls below $200") is fine — recurring
  // wording is optional. But an explicit ONE-SHOT swap command with a
  // trigger clause appended should stay assisted ONLY when it has no
  // trigger; by definition we got here because a trigger exists.

  const price = PRICE_POINT.exec(text);
  const triggerPrice = price ? (price[1] ?? price[2] ?? null) : null;
  if (!triggerPrice) return null;

  const target = extractTargetAsset(text);
  if (!target) return null;

  const spend = extractSpendAsset(text) ?? (isStablecoinLike(target) ? "USDC" : "USDC");
  const amount = AMOUNT.exec(text);
  const amountPerTrade = amount ? (amount[1] ?? amount[2] ?? amount[3] ?? amount[4] ?? null) : null;

  return {
    triggerKind: below ? "price_below" : "price_above",
    triggerPrice,
    targetAsset: target,
    spendAsset: spend,
    amountPerTrade,
  };
}

function isStablecoinLike(symbol: string): boolean {
  return /^(usdc|usd|usdt|dai|usds|cadc|tusd)$/i.test(symbol);
}

/** The traded asset: ticker after buy/sell, or a known -c B20 ticker in the text. */
function extractTargetAsset(text: string): string | null {
  const buySell = /\b(?:buy|sell|accumulate|purchase)\s+([a-z]{2,10}c?)\b/i.exec(text);
  if (buySell) {
    const raw = buySell[1];
    if (!isQuantityWord(raw)) return normalizeTicker(raw);
  }
  const b20 = /\b([A-Z]{2,6}c)\b/.exec(text);
  if (b20 && !isQuantityWord(b20[1])) return normalizeTicker(b20[1]);
  return null;
}

function extractSpendAsset(text: string): string | null {
  const with_ = /\b(?:with|in|using|of)\s+(usdc|usdt|dai|eth|weth|mpgr)\b/i.exec(text);
  if (with_) return with_[1].toUpperCase();
  return null;
}

function isQuantityWord(word: string): boolean {
  return /^(a|an|the|more|some|my|it|them|that|this)$/i.test(word);
}

function normalizeTicker(raw: string): string {
  const upper = raw.toUpperCase();
  const canonical: Record<string, string> = {
    AAPL: "AAPLc", AAPLC: "AAPLc",
    TSLA: "TSLAc", TSLAC: "TSLAc",
    NVDA: "NVDAc", NVDAC: "NVDAc",
    MSTR: "MSTRc", MSTRC: "MSTRc",
    SPCX: "SPCXc", SPCXC: "SPCXc",
    GOOGL: "GOOGLc", GOOGLC: "GOOGLc",
    AMZN: "AMZNc", AMZNC: "AMZNc",
    META: "METAc", METAC: "METAc",
    MSFT: "MSFTc", MSFTC: "MSFTc",
    COIN: "COINc", COINC: "COINc",
  };
  const hit = canonical[upper];
  if (hit) return hit;
  // Unknown ticker: preserve the user's exact casing — never invent one.
  return raw;
}

/**
 * The chat reply (spec §20): explain the autonomous option, state the
 * safety boundary, and point at review/authorization — never activate.
 */
export function buildAutonomyReplyText(match: AutonomyRequestMatch): string {
  const limit = match.amountPerTrade ? ` up to ${match.amountPerTrade} ${match.spendAsset} per trade` : "";
  return [
    `I can create this as an autonomous goal: ${match.triggerKind === "price_below" ? "buy" : "sell"} ${match.targetAsset} when the price goes ${match.triggerKind === "price_below" ? "below" : "above"} ${match.triggerPrice} ${match.spendAsset}${limit}.`,
    "",
    "It would only ever execute inside limits you explicitly authorize (per-trade cap, daily cap, slippage, expiry) — and autonomous trading is OFF until you review and activate it. MPGR never holds your keys: with no delegation set up, the goal simply watches and notifies you.",
    "",
    "Open “Autonomous Goals” below the chat to review the draft, set your limits, and authorize it. Until then nothing executes.",
  ].join("\n");
}

export function buildGoalDraft(match: AutonomyRequestMatch, sourcePrompt: string): AutonomyGoalDraft {
  return {
    targetAsset: match.targetAsset,
    spendAsset: match.spendAsset,
    side: match.triggerKind === "price_below" ? "buy" : "sell",
    triggerKind: match.triggerKind,
    triggerPrice: match.triggerPrice,
    amountPerTrade: match.amountPerTrade,
    sourcePrompt,
  };
}
