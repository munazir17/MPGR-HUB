export function normalizePrompt(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[?.!,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const TRADE_PROMPT_MARKERS = [
  "tokenized stock",
  "tokenized stocks",
  "coinc",
  "aaplc",
  "aapl",
  "tslac",
  "tsla",
  "nvdac",
  "nvda",
  "googlc",
  "googl",
  "amznc",
  "amzn",
  "msftc",
  "msft",
  "metac",
  "crclc",
  "intcc",
  "mstrc",
  "sndkc",
  "spcxc",
  "b20",
  "swap quote",
  "trade quote",
  "buy quote",
  "prepare a swap",
  "prepare a trade",
  "prepare a $",
  "prepare a quote",
  "buy $",
  "dex liquidity",
  "coinbase tokenized",
  "secondary-market",
  "secondary market",
] as const;

export const TRADE_QUOTE_MARKERS = [
  "buy quote",
  "swap quote",
  "trade quote",
  "prepare a swap",
  "prepare a trade",
  "prepare a $",
  "prepare a quote",
  "buy $",
  "buy ",
  "swap ",
  "quote",
] as const;

export const TRADE_SYMBOLS: { needle: string; ticker: string }[] = [
  { needle: "coinc", ticker: "COINc" },
  { needle: "aaplc", ticker: "AAPLc" },
  { needle: "tslac", ticker: "TSLAc" },
  { needle: "nvdac", ticker: "NVDAc" },
  { needle: "googlc", ticker: "GOOGLc" },
  { needle: "amznc", ticker: "AMZNc" },
  { needle: "msftc", ticker: "MSFTc" },
  { needle: "metac", ticker: "METAc" },
  { needle: "crclc", ticker: "CRCLc" },
  { needle: "intcc", ticker: "INTCc" },
  { needle: "mstrc", ticker: "MSTRc" },
  { needle: "sndkc", ticker: "SNDKc" },
  { needle: "spcxc", ticker: "SPCXc" },
  { needle: "aapl", ticker: "AAPLc" },
  { needle: "apple", ticker: "AAPLc" },
  { needle: "tsla", ticker: "TSLAc" },
  { needle: "tesla", ticker: "TSLAc" },
  { needle: "nvda", ticker: "NVDAc" },
  { needle: "nvidia", ticker: "NVDAc" },
  { needle: "googl", ticker: "GOOGLc" },
  { needle: "google", ticker: "GOOGLc" },
  { needle: "amzn", ticker: "AMZNc" },
  { needle: "amazon", ticker: "AMZNc" },
  { needle: "msft", ticker: "MSFTc" },
  { needle: "microsoft", ticker: "MSFTc" },
  { needle: "crcl", ticker: "CRCLc" },
  { needle: "circle", ticker: "CRCLc" },
  { needle: "intc", ticker: "INTCc" },
  { needle: "intel", ticker: "INTCc" },
  { needle: "mstr", ticker: "MSTRc" },
  { needle: "microstrategy", ticker: "MSTRc" },
  { needle: "sndk", ticker: "SNDKc" },
  { needle: "sandisk", ticker: "SNDKc" },
  { needle: "spcx", ticker: "SPCXc" },
  { needle: "spacex", ticker: "SPCXc" },
];

/**
 * Every catalog ticker, for the "<number> <ticker>" amount shape
 * ("sell 5 MSTRc", "buy 2 NVDAc"). Built from TRADE_SYMBOLS so a new
 * catalog asset is understood here automatically instead of silently
 * reading as "no amount given".
 */
const TRADE_UNIT_TICKERS = [
  ...new Set(TRADE_SYMBOLS.map((entry) => entry.ticker.toLowerCase())),
].join("|");

const TRADE_UNIT_AMOUNT_RE = new RegExp(
  "\\b([0-9]+(?:\\.[0-9]+)?)\\s+(?:shares?|tokens?|" + TRADE_UNIT_TICKERS + ")\\b",
  "i",
);

export function looksLikeTradePrompt(normalized: string): boolean {
  return TRADE_PROMPT_MARKERS.some((marker) => normalized.includes(marker));
}

export function looksLikeTradeQuotePrompt(normalized: string): boolean {
  return TRADE_QUOTE_MARKERS.some((marker) => normalized.includes(marker));
}

export function isTradePrompt(rawPrompt: string): boolean {
  return looksLikeTradePrompt(normalizePrompt(rawPrompt));
}

export function isTradeQuotePrompt(rawPrompt: string): boolean {
  return looksLikeTradeQuotePrompt(normalizePrompt(rawPrompt));
}

export function normalizeSwapToken(raw: string): string {
  const t = raw.replace(/^\$/, "").toLowerCase();
  if (t === "eth" || t === "weth") return t === "weth" ? "WETH" : "ETH";
  if (t === "usdc") return "USDC";
  if (t === "mpgr") return "MPGR";
  return raw.toUpperCase();
}

export function extractCryptoSwapPair(rawPrompt: string): { fromToken: string; toToken: string } | null {
  const text = rawPrompt.toLowerCase();
  // Word boundaries matter: without them a wrapped ticker that merely
  // CONTAINS a core symbol matched the wrong side — "swap 10 USDC to
  // cbETH" parsed as USDC → ETH. The extended catalog parser
  // (agent-intelligence/swap-intent.ts) now owns those tokens, so the
  // core parser must decline them instead of mis-reading them.
  const token = "(?:\\$)?\\b(eth|weth|usdc|mpgr)\\b";

  const howMuch = text.match(
    new RegExp("how much\\s+" + token + "[\\s\\w,]{0,48}?\\b(?:for|from)\\s+(?:[0-9]+(?:\\.[0-9]+)?)?\\s*" + token, "i"),
  );
  if (howMuch) {
    const toToken = normalizeSwapToken(howMuch[1]);
    const fromToken = normalizeSwapToken(howMuch[2]);
    if (fromToken !== toToken) return { fromToken, toToken };
  }

  const priceIn = text.match(
    new RegExp("\\b" + token + "\\b(?:\\s+price)?\\s+in\\s+" + token, "i"),
  );
  if (priceIn) {
    const fromToken = normalizeSwapToken(priceIn[1]);
    const toToken = normalizeSwapToken(priceIn[2]);
    if (fromToken !== toToken) return { fromToken, toToken };
  }

  const pairRe = new RegExp(token + "\\s*(?:to|->|/)\\s*" + token, "i");
  const match = text.match(pairRe);
  if (!match) return null;
  const fromToken = normalizeSwapToken(match[1]);
  const toToken = normalizeSwapToken(match[2]);
  if (fromToken === toToken) return null;
  return { fromToken, toToken };
}

export function extractCryptoSwapAmount(rawPrompt: string): string | null {
  const match = rawPrompt.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:eth|weth|usdc|mpgr)\b/i);
  return match?.[1] ?? null;
}

export function isCryptoSwapQuotePrompt(rawPrompt: string): boolean {
  const pair = extractCryptoSwapPair(rawPrompt);
  if (!pair) return false;
  const normalized = normalizePrompt(rawPrompt);
  return (
    normalized.includes("quote") ||
    normalized.includes("swap") ||
    normalized.includes("price") ||
    normalized.includes("how much") ||
    normalized.includes("what can i get")
  );
}

export function extractTradeSymbol(rawPrompt: string): string | null {
  const normalized = normalizePrompt(rawPrompt);
  for (const entry of TRADE_SYMBOLS) {
    if (normalized.includes(entry.needle)) return entry.ticker;
  }
  return null;
}

/**
 * True when the user is giving an EXECUTION order for an asset
 * ("sell my USDC worth of MSTRc", "buy 5 USDC of ETH", "swap 10 USDC to
 * cbADA") rather than asking for research/analysis.
 *
 * This is the switch that keeps the two behaviors apart: an execution
 * order must reach the live quote/prepare path (proposal → confirmation
 * modal → wallet signature), while "check AAPLc price", "NVDAc premium vs
 * feed" or "should I buy AAPLc?" stay research-only.
 *
 * Deliberately narrow: a trade verb alone is not enough — advice and
 * how-to questions are excluded, because those are questions ABOUT
 * trading, not orders.
 */
export function isTradeExecutionPrompt(rawPrompt: string): boolean {
  const text = normalizePrompt(rawPrompt);
  if (!/\b(buy|sell|swap|trade|order|convert|exchange)\b/.test(text)) return false;
  const advice =
    /^(should|why|when)\b|\bshould (?:i|we)\b|\bhow (?:do|does|can|to|would|much do)\b|\bis it (?:a )?good\b|\b(?:good|right) time to\b|\bworth (?:buying|selling)\b|\bthoughts on\b|\bwhat do you think\b|\btrade ideas?\b/;
  return !advice.test(text);
}

export function isTradeSellPrompt(rawPrompt: string): boolean {
  return /\bsell\b/.test(normalizePrompt(rawPrompt));
}

export interface TokenizedStockOrderAmount {
  amount: string;
  /**
   * "usd"   — the user gave a dollar figure ("$5", "5 USDC", "5 worth of").
   * "token" — the user gave a share/token count ("Sell 5 AAPLc").
   */
  unit: "usd" | "token";
}

/**
 * Unit-aware amount for a Coinbase B20 tokenized-stock order.
 *
 * Why this exists: a bare number next to a B20 ticker is a SHARE count
 * ("Sell 5 AAPLc" = 5 shares ≈ $1,688), but it was being read as a
 * dollar budget by extractTradeHumanAmount — so the order showed up as
 * $5 and could not be sized at that precision. Dollar-shaped amounts
 * ("$5 of my AAPLc", "5 USDC worth of MSTRc") keep their meaning; only a
 * number attached to the ticker / "shares" / "tokens" becomes a count.
 *
 * Returns null when the prompt states no amount at all, so the caller
 * asks for one instead of guessing.
 */
export function extractTokenizedStockOrderAmount(
  rawPrompt: string,
  symbol: string,
): TokenizedStockOrderAmount | null {
  const USD_NUMBER = "[0-9]+(?:\\.[0-9]+)?";
  const dollar = rawPrompt.match(new RegExp(`\\$\\s*(${USD_NUMBER})`));
  if (dollar) return { amount: dollar[1], unit: "usd" };

  const usdc = rawPrompt.match(new RegExp(`\\b(${USD_NUMBER})\\s*(?:usdc|usd)\\b`, "i"));
  if (usdc) return { amount: usdc[1], unit: "usd" };

  const worth = rawPrompt.match(new RegExp(`\\b(${USD_NUMBER})\\s+worth\\b`, "i"));
  if (worth) return { amount: worth[1], unit: "usd" };

  // A count: "<n> AAPLc", "<n> AAPL", "<n> shares [of AAPLc]", "<n> tokens".
  // The B20 ticker and its underlying both count — the catalog resolves
  // them to the same contract.
  const tickerPattern = symbol
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/c$/i, "c?");
  const ticker = rawPrompt.match(new RegExp(`\\b(${USD_NUMBER})\\s+${tickerPattern}\\b`, "i"));
  if (ticker) return { amount: ticker[1], unit: "token" };

  const units = rawPrompt.match(new RegExp(`\\b(${USD_NUMBER})\\s+(?:shares?|tokens?|stocks?)\\b`, "i"));
  if (units) return { amount: units[1], unit: "token" };

  return null;
}

export function extractTradeHumanAmount(rawPrompt: string): string | null {
  const dollar = rawPrompt.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (dollar) return dollar[1];
  const usdc = rawPrompt.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:usdc|usd)\b/i);
  if (usdc) return usdc[1];
  const worth = rawPrompt.match(/\b([0-9]+(?:\.[0-9]+)?)\s+worth\b/i);
  if (worth) return worth[1];
  const units = rawPrompt.match(TRADE_UNIT_AMOUNT_RE);
  if (units) return units[1];
  return null;
}

export const X402_PAYMENT_ACTION_MARKERS = [
  "payment proposal",
  "payto",
  "resourceurl",
  "prepare a payment",
  "prepare payment",
  "pay this resource",
  "x402 resource",
] as const;

export const X402_INFO_MARKERS = [
  "explain x402",
  "what is x402",
  "how x402",
  "how does x402",
  "x402 and how",
];

export function looksLikeX402InformationalPrompt(normalized: string): boolean {
  return X402_INFO_MARKERS.some((marker) => normalized.includes(marker)) && !normalized.includes("https://");
}

export function looksLikeX402PaymentPrompt(normalized: string): boolean {
  if (looksLikeX402InformationalPrompt(normalized)) return false;
  if (normalized.includes("https://") && normalized.includes("x402")) return true;
  // "Prepare the $0.02 x402 payment for the live Base Stocks tape
  // snapshot" — the paid tape resource is this app's own x402 endpoint;
  // advertise the discover/prepare payment tools even without a URL.
  if (normalized.includes("x402 payment") && normalized.includes("tape")) return true;
  return X402_PAYMENT_ACTION_MARKERS.some((marker) => normalized.includes(marker));
}

export function isX402PaymentPrompt(rawPrompt: string): boolean {
  return looksLikeX402PaymentPrompt(normalizePrompt(rawPrompt));
}

export const TRANSFER_PROMPT_MARKERS = [
  "send ",
  "transfer ",
  "pay ",
  "base transfer",
  "plan a base transfer",
  "send eth",
  "send usdc",
  "send mpgr",
] as const;

export const TRANSFER_PARSE_RE =
  /\b(?:send|transfer|sending|pay)\s+(?:of\s+)?([0-9]+(?:\.[0-9]+)?)\s+([a-z0-9.]{2,12}|0x[0-9a-f]{40})\s+to\s+(0x[0-9a-fA-F]{40}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.base\.eth)/i;

export function isTransferPrompt(rawPrompt: string): boolean {
  const normalized = normalizePrompt(rawPrompt);
  if (TRANSFER_PROMPT_MARKERS.some((marker) => normalized.includes(marker))) return true;
  return TRANSFER_PARSE_RE.test(rawPrompt);
}

export function extractTransferRequest(rawPrompt: string): {
  token: string;
  amount: string;
  recipient: string;
} | null {
  const match = rawPrompt.match(TRANSFER_PARSE_RE);
  if (!match) return null;
  const amount = match[1]?.trim();
  const token = match[2]?.trim();
  const recipient = match[3]?.trim();
  if (!amount || !token || !recipient) return null;
  return { token, amount, recipient };
}

export function extractX402ResourceUrl(rawPrompt: string): string | null {
  const match = rawPrompt.match(/https:\/\/[^\s<>"'\]\)]+/i);
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[.,;]+$/g, ""));
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
