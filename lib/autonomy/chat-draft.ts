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
//
// PERCENT TRIGGERS (production fix): "Buy AAPLc when it drops 1%" used to
// fall through to the one-shot swap flow because PRICE_POINT requires an
// absolute dollar number. A relative percent trigger is now detected and
// ANCHORED at draft time: the live reference price is fetched by the
// caller (deterministic provider, via the read-only get_pair tool) and the
// stored trigger is price_below at reference × (1 − pct/100). Both numbers
// ride on the draft so the UI can show "AAPLc is 347 — 1% down is 343.53".
//
// ALLOWLIST DISCIPLINE: only symbols already on the delegated executor's
// allowlist WITH a registered USDC route (live B20 stocks, the official
// wrapped assets, WETH) may become drafts. Anything else produces a draft
// that says it is NOT available for autonomous trading — no tokens, routes,
// or contract allowlist entries are added here.

import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, findExecutorRoute } from "@/lib/executor/executor-config";

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
  /**
   * Percent triggers only: the reference price the trigger was anchored to
   * at draft time (decimal string), e.g. "347" for "drops 1%". Null for
   * absolute-dollar triggers.
   */
  referencePrice?: string | null;
  /** Percent triggers only: the requested move, e.g. 1 for "drops 1%". */
  percentDrop?: number | null;
  /**
   * False only when the named asset is NOT on the delegated allowlist (or
   * has no registered USDC route): the draft exists purely to SAY that in
   * the UI and must never be activatable.
   */
  supported?: boolean;
  /** Human-readable reason when supported is false. */
  unsupportedReason?: string | null;
}

const TRIGGER_BELOW = /\b(?:when|whenever|if|once|each time|every time)\b[^.?!]{0,80}?\b(?:falls?|drops?|goes|go|dips?|gets?)\s+(?:to|below|under)\b/i;
const TRIGGER_BELOW_ALT = /\b(?:falls?|drops?|dips?)\s+below\b/i;
const TRIGGER_ABOVE = /\b(?:when|whenever|if|once|each time|every time)\b[^.?!]{0,80}?\b(?:rises?|rally|goes|go|climbs?|gets?)\s+(?:to|above|over|past)\b/i;
const TRIGGER_ABOVE_ALT = /\b(?:rises?|climbs?)\s+(?:above|over|past)\b/i;
const RECURRING = /\b(?:whenever|each time|every time|repeatedly|recurring|keep buying|keep selling|automatically|daily)\b/i;
const PRICE_POINT = /\$\s*(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*(?:usd|usdc)\b/i;
const AMOUNT = /\bmax(?:imum)?\b[^.?!]{0,20}?\$?\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\s*(?:per|each)\s*trade|\$?\s*(\d+(?:\.\d+)?)\s*(?:per|each)\s*trade|\b(?:buy|sell|spend|invest)\s+\$?\s*(\d+(?:\.\d+)?)(?=\b)/i;
/**
 * Relative percent triggers: "drops 1%", "falls 1%", "down 1 percent",
 * "dips 1.5 %". Deliberately narrow — a move VERB (or "down") immediately
 * followed by a number and %/percent. "drops to 250" can never match (the
 * preposition intervenes), and an absolute dollar point always wins over a
 * percent when both appear.
 */
const PERCENT_BELOW = /\b(?:falls?|drops?|dips?|slides?|down)\s+(?:by\s+)?(\d{1,2}(?:\.\d+)?)\s*(?:%|percent)(?![a-z])/i;
const PERCENT_ABOVE = /\b(?:rises?|climbs?|gains?|jumps?|up)\s+(?:by\s+)?(\d{1,2}(?:\.\d+)?)\s*(?:%|percent)(?![a-z])/i;
/** Percent triggers outside 0 < pct <= 50 are treated as misparses. */
const MAX_PLAUSIBLE_PERCENT = 50;

export interface AutonomyRequestMatch {
  triggerKind: "price_below" | "price_above";
  /**
   * Absolute dollar trigger when the prompt named a price point; the empty
   * string when the trigger is relative (percentDrop is set) and the price
   * still has to be anchored to the live reference.
   */
  triggerPrice: string;
  /** Percent move for relative triggers ("drops 1%" → 1), else null. */
  percentDrop: number | null;
  targetAsset: string;
  spendAsset: string;
  amountPerTrade: string | null;
}

/**
 * Returns a match ONLY when the prompt is unambiguously autonomous:
 * a trigger phrase ("when it falls below X", "when it drops 1%") possibly
 * plus recurring phrasing. A one-shot swap request ("swap 1 USDC to AAPLc")
 * never matches.
 */
export function detectAutonomousTradeRequest(prompt: string): AutonomyRequestMatch | null {
  if (!prompt || prompt.length > 400) return null;
  const text = prompt.trim();
  if (text.length < 12) return null;

  const below = TRIGGER_BELOW.test(text) || TRIGGER_BELOW_ALT.test(text);
  const above = TRIGGER_ABOVE.test(text) || TRIGGER_ABOVE_ALT.test(text);

  // Relative percent trigger: "drops 1%". Consulted first so an AMOUNT like
  // "max 5 USDC per trade" can never be mis-read as the trigger price point.
  const percent = parsePercentTrigger(text);

  // Absolute dollar price point — it always wins over a percent when a real
  // one exists, but a candidate that overlaps the per-trade AMOUNT clause
  // ("…drops 1%, max 5 USDC per trade") is not a price and is skipped.
  const amount = AMOUNT.exec(text);
  const amountSpan = amount ? { from: amount.index, to: amount.index + amount[0].length } : null;
  const dollarPrice = firstNonOverlappingPricePoint(text, amountSpan);

  if (!dollarPrice && !percent) return null;
  // A trigger clause is still REQUIRED for absolute prices (unchanged from
  // the original matcher); a bare percent phrasing ("drops 1%") carries the
  // direction itself, so it does not need a separate below/above clause.
  if (dollarPrice && !below && !above) return null;

  const target = extractTargetAsset(text);
  if (!target) return null;

  const spend = extractSpendAsset(text) ?? (isStablecoinLike(target) ? "USDC" : "USDC");
  const amountPerTrade = amount ? (amount[1] ?? amount[2] ?? amount[3] ?? amount[4] ?? null) : null;

  return {
    triggerKind: dollarPrice ? (below ? "price_below" : "price_above") : percent!.kind,
    triggerPrice: dollarPrice ?? "",
    percentDrop: percent ? percent.percent : null,
    targetAsset: target,
    spendAsset: spend,
    amountPerTrade,
  };
}

function parsePercentTrigger(text: string): { percent: number; kind: "price_below" | "price_above" } | null {
  const below = PERCENT_BELOW.exec(text);
  const above = PERCENT_ABOVE.exec(text);
  const hit = below ?? above;
  if (!hit) return null;
  const pct = Number.parseFloat(hit[1]);
  if (!Number.isFinite(pct) || pct <= 0 || pct > MAX_PLAUSIBLE_PERCENT) return null;
  return { percent: pct, kind: below ? "price_below" : "price_above" };
}

/**
 * First PRICE_POINT match that does NOT sit inside the per-trade amount
 * clause, so "max 5 USDC per trade" is never mistaken for a trigger price.
 */
function firstNonOverlappingPricePoint(text: string, amountSpan: { from: number; to: number } | null): string | null {
  const re = new RegExp(PRICE_POINT.source, "gi");
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(text)) !== null) {
    if (amountSpan && hit.index < amountSpan.to && hit.index + hit[0].length > amountSpan.from) continue;
    return hit[1] ?? hit[2] ?? null;
  }
  return null;
}

/**
 * Decimal-safe reference × (1 ∓ pct/100). Whole-fraction integer math so
 * "347 − 1%" is exactly 343.53 (no float dust like 343.53000000000003).
 */
export function applyPercentToReference(reference: string, percent: number, kind: "price_below" | "price_above"): string {
  const ref = parseDecimal(reference);
  if (!ref) return "";
  const pct = parseDecimal(String(percent));
  if (!pct) return "";
  const EXTRA = 8; // extra fractional digits before trimming
  const pctScale = 10n ** BigInt(pct.decimals);
  const basis = kind === "price_below" ? 100n * pctScale - pct.value : 100n * pctScale + pct.value;
  if (basis <= 0n) return "";
  const outScale = ref.decimals + EXTRA;
  const scaled = (ref.value * 10n ** BigInt(EXTRA) * basis) / (100n * pctScale);
  const whole = scaled / 10n ** BigInt(outScale);
  let frac = (scaled % 10n ** BigInt(outScale)).toString().padStart(outScale, "0");
  frac = frac.replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function parseDecimal(input: string): { value: bigint; decimals: number } | null {
  const text = input.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const decimals = frac.length;
  return { value: BigInt(whole + frac), decimals };
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

// ---------------------------------------------------------------------------
// Delegated allowlist gate (NO new tokens/routes are added anywhere).
//
// The delegated executor's Base-mainnet registry IS the autonomous universe:
// USDC (spend), WETH, and the live B20 tokenized stocks, each paired with a
// registered USDC route. A draft target must already be on it.
// ---------------------------------------------------------------------------

export interface AutonomyTargetCheck {
  ok: boolean;
  /** Resolved allowlist facts when ok (address + decimals for the form). */
  symbol?: string;
  address?: string;
  decimals?: number;
  reason?: string;
}

/** Symbols currently allowed for autonomous targets (delegated allowlist, USDC-routed). */
export function autonomyAllowedTargetSymbols(): string[] {
  const usdc = BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.find((t) => t.symbol.toUpperCase() === "USDC");
  return BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens
    .filter((t) => usdc && t.address.toLowerCase() !== usdc.address.toLowerCase())
    .filter((t) => findExecutorRoute(BASE_MAINNET_EXECUTOR_DEPLOYMENT, usdc!.address, t.address) !== null)
    .map((t) => t.symbol);
}

/** The symbol must already be allowlisted AND have a registered USDC route. */
export function checkAutonomyTarget(symbol: string): AutonomyTargetCheck {
  const needle = symbol.trim().toUpperCase();
  const token = BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.find((t) => t.symbol.toUpperCase() === needle);
  if (!token) {
    return {
      ok: false,
      reason: `${symbol} is not available for autonomous trading. Autonomous goals support only assets on the delegated executor allowlist with a registered USDC route: ${autonomyAllowedTargetSymbols().join(", ")}.`,
    };
  }
  const usdc = BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.find((t) => t.symbol.toUpperCase() === "USDC")!;
  if (token.address.toLowerCase() === usdc.address.toLowerCase()) {
    return { ok: false, reason: "USDC is the spend currency — there is nothing to buy. Pick an asset such as " + autonomyAllowedTargetSymbols().join(", ") + "." };
  }
  if (!findExecutorRoute(BASE_MAINNET_EXECUTOR_DEPLOYMENT, usdc.address, token.address)) {
    return { ok: false, reason: `${token.symbol} has no registered USDC route on the delegated executor, so it cannot be traded autonomously.` };
  }
  return { ok: true, symbol: token.symbol, address: token.address, decimals: token.decimals };
}

// ---------------------------------------------------------------------------
// Amount-only follow-up: "1 USDC", "$1", "0.5 USDC" …
// ---------------------------------------------------------------------------

/**
 * Matches a message that is ONLY an amount (optionally with the spend
 * currency spelled out). Deliberately tiny: ≤ 24 chars, no verbs, no
 * tickers. The CALLER decides whether an autonomous draft is actually
 * open in this conversation — without one, this never fires.
 */
export function detectAmountOnlyFollowUp(prompt: string): { amount: string } | null {
  const text = (prompt ?? "").trim();
  if (!text || text.length > 24) return null;
  const hit = /^\$\s*(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?|bucks)?(?:\s+per\s+trade)?$/i.exec(text);
  if (!hit) return null;
  const amount = (hit[1] ?? hit[2] ?? "").replace(",", ".");
  return amount && /^\d+(\.\d+)?$/.test(amount) && Number.parseFloat(amount) > 0 ? { amount } : null;
}

/** Attaches a per-trade amount to an OPEN draft (pure — returns a new draft). */
export function applyAmountToDraft(draft: AutonomyGoalDraft, amount: string): AutonomyGoalDraft {
  return {
    ...draft,
    amountPerTrade: amount,
    sourcePrompt: draft.sourcePrompt,
  };
}

/**
 * The chat reply (spec §20): explain the autonomous option, state the
 * safety boundary, and point at review/authorization — never activate.
 * With an anchored percent trigger the reply shows BOTH numbers.
 */
export function buildAutonomyReplyText(match: AutonomyRequestMatch, anchor?: { referencePrice: string } | null): string {
  const limit = match.amountPerTrade ? ` up to ${match.amountPerTrade} ${match.spendAsset} per trade` : "";
  const triggerPrice =
    match.percentDrop != null && anchor?.referencePrice
      ? applyPercentToReference(anchor.referencePrice, match.percentDrop, match.triggerKind)
      : match.triggerPrice;
  const lines: string[] = [];
  if (match.percentDrop != null && anchor?.referencePrice && triggerPrice) {
    const verb = match.triggerKind === "price_below" ? "below" : "above";
    lines.push(
      `${match.targetAsset} is ${anchor.referencePrice} — ${match.percentDrop}% ${match.triggerKind === "price_below" ? "down" : "up"} is ${triggerPrice}.`,
      "",
      `I can create this as an autonomous goal: ${match.triggerKind === "price_below" ? "buy" : "sell"} ${match.targetAsset} when the price goes ${verb} ${triggerPrice} ${match.spendAsset}${limit}.`,
    );
  } else {
    lines.push(
      `I can create this as an autonomous goal: ${match.triggerKind === "price_below" ? "buy" : "sell"} ${match.targetAsset} when the price goes ${match.triggerKind === "price_below" ? "below" : "above"} ${triggerPrice} ${match.spendAsset}${limit}.`,
    );
  }
  return [
    ...lines,
    "",
    "It would only ever execute inside limits you explicitly authorize (per-trade cap, daily cap, slippage, expiry) — and autonomous trading is OFF until you review and activate it. MPGR never holds your keys: with no delegation set up, the goal simply watches and notifies you.",
    "",
    "Review the draft card below this message to confirm the details and authorize it. Until then nothing executes.",
  ].join("\n");
}

export function buildGoalDraft(
  match: AutonomyRequestMatch,
  sourcePrompt: string,
  anchor?: { referencePrice: string } | null,
): AutonomyGoalDraft {
  let triggerPrice = match.triggerPrice;
  if (match.percentDrop != null) {
    // Percent triggers MUST be anchored at draft time — the reference price
    // is a caller-supplied live read, never a guess.
    triggerPrice = anchor?.referencePrice ? applyPercentToReference(anchor.referencePrice, match.percentDrop, match.triggerKind) : "";
  }
  const check = checkAutonomyTarget(match.targetAsset);
  return {
    targetAsset: match.targetAsset,
    spendAsset: match.spendAsset,
    side: match.triggerKind === "price_below" ? "buy" : "sell",
    triggerKind: match.triggerKind,
    triggerPrice,
    amountPerTrade: match.amountPerTrade,
    sourcePrompt,
    referencePrice: match.percentDrop != null ? anchor?.referencePrice ?? null : null,
    percentDrop: match.percentDrop,
    supported: check.ok,
    unsupportedReason: check.ok ? null : check.reason ?? null,
  };
}
