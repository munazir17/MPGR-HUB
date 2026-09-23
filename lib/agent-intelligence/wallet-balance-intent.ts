// lib/agent-intelligence/wallet-balance-intent.ts
//
// Strict wallet-balance intent parser.
//
// Why this exists: "What is my MSTRc balance?" used to match the generic
// portfolio_summary markers ("my balance") and was answered with the whole
// MPGR portfolio dump — ETH + MPGR in wallet + USDC + staked + locked +
// total exposure + Holder Score — while never mentioning MSTRc. A single
// token balance question must answer exactly that token, and nothing else.
//
// Three shapes, never mixed:
//   single → one asset's balance, in ONE scope (wallet / staked / locked /
//            exposure), resolved through the same catalog the swap routes
//            trust (lib/trade/trade-tokens.ts)
//   all    → every wallet-held asset in this app's supported catalog
//   total  → what the wallet is worth
//
// Rules baked in:
//   - a named asset that resolves is answered from the live catalog; a
//     named asset that does NOT resolve asks for a symbol/address instead
//     of dumping the whole wallet
//   - trade/transfer/lock/stake ACTIONS, how-to questions, explainers and
//     research questions are rejected here so they keep their existing
//     routing (swap → execution flow, "how do I…" → help, XP/staking →
//     their own intents)
//   - wallet / staked / locked / exposure are separate scopes and are
//     never silently merged
//   - nothing is invented: resolution failure is reported, not guessed

import { resolveTradeToken } from "@/lib/trade/trade-tokens";
import { extractTradeSymbol, normalizePrompt } from "./prompt-parsers";

export type WalletBalanceScope = "wallet" | "staked" | "locked" | "exposure";

export interface WalletBalanceSingleRequest {
  kind: "single";
  /** Canonical symbol when resolved, else the raw mention. */
  token: string;
  /** False only when the user named an asset this app cannot resolve. */
  resolved: boolean;
  /** The token text exactly as the user wrote it. */
  mention: string;
  scope: WalletBalanceScope;
}

export interface WalletBalanceAllRequest {
  kind: "all";
}

export interface WalletBalanceTotalRequest {
  kind: "total";
}

export type WalletBalanceRequest =
  | WalletBalanceSingleRequest
  | WalletBalanceAllRequest
  | WalletBalanceTotalRequest;

// ---------------------------------------------------------------------------
// Guard rails — what this parser deliberately refuses to claim
// ---------------------------------------------------------------------------

/**
 * Trade / transfer / payment verbs. Those prompts already have their own
 * routing (the live execution flow, or the send flow) and must never be
 * answered with a balance.
 */
const ACTION_VERB_RE =
  /\b(?:swap|swapping|convert|exchange|sell|selling|buy|buying|trade|trading|prepare|quote|send|sending|transfer|transferring|pay|payment|deposit|withdraw)\b/;

/**
 * Staking/locking ACTIONS ("stake 100 MPGR", "lock my MPGR", "unlock
 * tokens") are commands, not balance questions. The states — "staked",
 * "locked", "staking balance" — are scopes and stay allowed.
 */
const STAKE_LOCK_ACTION_RE =
  /\b(?:stake|unstake|lock|unlock)\s+(?:\$?\d|tokens?|shares?|my|the)\b/;

/** How-to questions are help, not a balance read. */
const HOWTO_START_RE =
  /^(?:how do i|how can i|how to|where do i|where can i|what'?s the best way|what is the best way|tell me how|explain|what does|why)\b/;

/** Explainers/comparisons of the concepts themselves are informational. */
const EXPLAINER_RE = /\b(?:difference between|means?|explain|vs\.?)\b/;

/**
 * "my tokenized stock holdings" belongs to the Coinbase Base Stocks
 * holdings tool (get_stock_holdings), which reports exactly those B20
 * positions — this wallet-balance layer must not answer it with a
 * different asset set.
 */
const STOCK_HOLDINGS_RE = /\b(?:tokenized|b20|stock|stocks|equit(?:y|ies))\b/;

/** Domain nouns that are NOT on-chain tokens — never treated as a symbol. */
const NON_TOKEN_WORDS = new Set([
  "a",
  "account",
  "all",
  "an",
  "any",
  "apy",
  "apr",
  "asset",
  "assets",
  "bag",
  "balance",
  "balances",
  "coin",
  "coins",
  "fee",
  "fees",
  "gas",
  "holder",
  "holding",
  "holdings",
  "i",
  "invite",
  "invites",
  "leaderboard",
  "level",
  "locked",
  "market",
  "me",
  "my",
  "net",
  "points",
  "portfolio",
  "premium",
  "price",
  "rank",
  "referral",
  "referrals",
  "reward",
  "rewards",
  "score",
  "season",
  "staked",
  "stak",
  "staking",
  "streak",
  "tier",
  "token",
  "tokens",
  "total",
  "tvl",
  "value",
  "volume",
  "wallet",
  "worth",
  "xp",
]);

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const BALANCE_NOUN_RE = /\b(?:balance|balances|holdings?|bag|exposure)\b/;
const HAVE_RE = /\b(?:do i (?:have|hold)|i (?:have|hold|own)|have i got)\b/;
const HOW_MUCH_RE = /\bhow (?:much|many)\b/;

const TOTAL_PATTERNS: readonly RegExp[] = [
  // "how much is my wallet worth", "what's my portfolio value"
  /\b(?:how much|what)(?:'s| is| are)?\s+(?:my|our|the)\s+(?:wallet|portfolio|account)\s+(?:worth|value)\b/,
  // "my wallet value", "total wallet value", "portfolio worth"
  /\b(?:total\s+)?(?:wallet|portfolio|account)\s+(?:worth|value|valuation)\b/,
  /\bnet worth\b/,
  /\bhow much (?:is|are) my (?:assets|tokens|coins|holdings) worth\b/,
];

const ALL_PATTERNS: readonly RegExp[] = [
  /\bwhat(?:'s| is| are)?\s+(?:in|inside)\s+(?:my|our|the)\s+wallet\b/,
  /\bshow (?:me )?(?:my|the) wallet\b/,
  /\b(?:show|list|see) (?:me )?(?:all )?my (?:balances|assets|tokens|coins|holdings)\b/,
  /\ball my (?:balances|assets|tokens|coins|holdings)\b/,
  /\bmy (?:balances|assets|tokens|coins|holdings)\b/,
  /\bwallet (?:assets|balances|holdings|contents)\b/,
  /\bwhat (?:tokens|assets|coins|balances) do i (?:have|hold|own)\b/,
  /\bwhat do i (?:have|hold|own) in my wallet\b/,
];

/** Wallet-scope token mention, in priority order. */
function findTokenMention(rawPrompt: string): string | null {
  const address = rawPrompt.match(/0x[0-9a-fA-F]{40}/);
  if (address) return address[0];

  // B20 tickers + their underlying names ("MSTRc", "microstrategy", "AAPL").
  const ticker = extractTradeSymbol(rawPrompt);
  if (ticker) return ticker;

  // Core + wrapped Coinbase assets (the same universe the swap routes use).
  const core = rawPrompt.match(
    /\b(eth|ethereum|weth|usdc|usd-coin|mpgr|cbBTC|cbETH|cbDOGE|cbXRP|cbLTC|cbADA)\b/i,
  );
  if (core) return core[1];

  // Generic "<symbol> balance" / "balance of <symbol>" — only used to ask
  // the user for a resolvable symbol, never to read an invented contract.
  const beforeNoun = rawPrompt.match(
    /\b([a-z][a-z0-9]{1,11})\s+(?:wallet\s+)?(?:balance|balances|holdings?|bag)\b/i,
  );
  const afterNoun = rawPrompt.match(
    /\b(?:balance|balances|holdings?|bag)\s+(?:of|for)\s+([a-z][a-z0-9]{1,11})\b/i,
  );
  const candidate = beforeNoun?.[1] ?? afterNoun?.[1] ?? null;
  if (candidate && !NON_TOKEN_WORDS.has(candidate.toLowerCase())) return candidate;
  return null;
}

function detectScope(normalized: string): WalletBalanceScope {
  if (/\bstak(?:e|ed|ing)\b/.test(normalized)) return "staked";
  if (/\blocked\b|\btoken lock\b|\block balance\b/.test(normalized)) return "locked";
  if (/\btotal\b|\bexposure\b|\baltogether\b|\ball together\b|\bcombined\b|\bin total\b/.test(normalized)) {
    return "exposure";
  }
  return "wallet";
}

function singleRequest(
  mention: string | null,
  normalized: string,
  hasBalanceNoun: boolean,
): WalletBalanceSingleRequest | null {
  if (!mention) return null;
  const resolved = resolveTradeToken(mention);
  const scope = detectScope(normalized);

  if (resolved.ok) {
    return {
      kind: "single",
      token: resolved.token.symbol,
      resolved: true,
      mention,
      scope,
    };
  }

  // An unresolved mention is only actionable when the user explicitly asked
  // for a balance/holding — otherwise ("how much volume do I have") it is
  // not a balance question at all and falls through.
  if (!hasBalanceNoun) return null;
  return { kind: "single", token: mention, resolved: false, mention, scope };
}

/**
 * Parses a wallet-balance question. Returns null for anything that is not
 * one, so every other prompt keeps its existing routing.
 */
export function parseWalletBalanceRequest(rawPrompt: string): WalletBalanceRequest | null {
  if (typeof rawPrompt !== "string" || !rawPrompt.trim()) return null;
  const normalized = normalizePrompt(rawPrompt);
  if (!normalized) return null;

  // Actions never route here.
  if (ACTION_VERB_RE.test(normalized)) return null;
  if (STAKE_LOCK_ACTION_RE.test(normalized)) return null;
  if (HOWTO_START_RE.test(normalized)) return null;
  if (EXPLAINER_RE.test(normalized)) return null;
  if (STOCK_HOLDINGS_RE.test(normalized)) return null;

  for (const pattern of TOTAL_PATTERNS) {
    if (pattern.test(normalized)) return { kind: "total" };
  }

  const hasBalanceNoun = BALANCE_NOUN_RE.test(normalized);
  const hasHaveShape = HAVE_RE.test(normalized) && HOW_MUCH_RE.test(normalized);

  for (const pattern of ALL_PATTERNS) {
    if (pattern.test(normalized)) return { kind: "all" };
  }

  if (!hasBalanceNoun && !hasHaveShape) return null;

  // "how much ETH do I have" — a have-shape WITHOUT a balance noun has to
  // name a real catalog asset (see singleRequest), so "how much XP do I
  // have?" and every other non-asset noun keep their existing intent.
  return singleRequest(findTokenMention(rawPrompt), normalized, hasBalanceNoun);
}

/** Cheap boolean form for routing layers that only need a yes/no. */
export function isWalletBalancePrompt(rawPrompt: string): boolean {
  return parseWalletBalanceRequest(rawPrompt) !== null;
}
