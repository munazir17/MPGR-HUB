import { formatCompactNumber } from "@/lib/format";
import type { AgentContext } from "@/lib/agent-context";
import { getAgentActions, getAgentHighlights, getFollowUpPrompts, type AgentAction, type AgentHighlight } from "@/lib/agent-actions";
import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";

function formatUpcomingDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export type AgentIntent =
  | "portfolio_summary"
  | "xp_status"
  | "holder_tier"
  | "premium_status"
  | "claimable_rewards"
  | "staking_summary"
  | "locked_tokens"
  | "season_progress"
  | "referral_overview"
  | "general_help"
  | "open_rewards"
  | "open_games"
  | "open_profile"
  | "open_staking"
  | "open_premium"
  | "open_leaderboard"
  | "suggest_next_action"
  | "research_query"
  | "market_overview";

export const AGENT_INTENTS: readonly AgentIntent[] = [
  "portfolio_summary",
  "xp_status",
  "holder_tier",
  "premium_status",
  "claimable_rewards",
  "staking_summary",
  "locked_tokens",
  "season_progress",
  "referral_overview",
  "general_help",
  "open_rewards",
  "open_games",
  "open_profile",
  "open_staking",
  "open_premium",
  "open_leaderboard",
  "suggest_next_action",
  "research_query",
  "market_overview",
];

export interface AgentIntelligenceResult {
  intent: AgentIntent;
  reply: string;
  actions: AgentAction[];
  highlights: AgentHighlight[];
  followUps: string[];
}

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[?.!,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const INTENT_PATTERNS: Record<AgentIntent, string[]> = {
  portfolio_summary: [
    "analyze my portfolio",
    "my portfolio",
    "show my portfolio",
    "portfolio summary",
    "my balance",
    "total holdings",
    "everything i have",
    "net worth",
    "overview of my",
    "summary of my mpgr",
    "how much mpgr do i have",
    "how much mpgr",
    "show my wallet",
    "whats in my wallet",
    "what's in my wallet",
    "my wallet",
  ],
  xp_status: [
    "how much xp",
    "my xp",
    "xp status",
    "experience point",
    "what level",
    "my level",
    "level am i",
    "show progress",
    "level progress",
  ],
  holder_tier: [
    "holder tier",
    "my tier",
    "what tier",
    "holder score",
    "voting weight",
    "governance weight",
    "reputation score",
  ],
  premium_status: [
    "premium",
    "subscription",
    "membership",
    "xp multiplier",
    "rewards multiplier",
    "compare premium",
    "premium tiers",
  ],
  claimable_rewards: [
    "claimable",
    "claim my reward",
    "show my rewards",
    "what rewards",
    "rewards can i claim",
    "do i have any claimable",
    "staking rewards",
    "rewards page",
    "what can i claim",
  ],
  staking_summary: ["stak", "staking position", "staking reward"],
  locked_tokens: ["locked", "token lock", "my lock", "unlock", "lock period"],
  season_progress: ["season pass", "season point", "season level", "season"],
  referral_overview: ["referral", "invite", "refer a friend", "my invites"],
  general_help: ["help", "what can you do", "what do you do"],
  open_rewards: ["open rewards", "go to rewards", "take me to rewards", "navigate to rewards", "open the rewards page"],
  open_games: ["open games", "go to games", "take me to games", "navigate to games", "play games", "show games page"],
  open_profile: [
    "open profile",
    "open my profile",
    "go to profile",
    "go to my profile",
    "take me to profile",
    "navigate to profile",
  ],
  open_staking: ["open staking", "go to staking", "take me to staking", "navigate to staking", "open the staking page"],
  open_premium: ["open premium", "go to premium", "take me to premium", "navigate to premium", "open the premium page"],
  open_leaderboard: [
    "open leaderboard",
    "go to leaderboard",
    "take me to leaderboard",
    "navigate to leaderboard",
    "show leaderboard",
  ],
  suggest_next_action: [
    "what should i do next",
    "what should i do",
    "best next action",
    "suggest something",
    "what do you recommend",
    "recommend something",
    "next step",
    "what next",
  ],
  research_query: [
    "what is mpgr hub",
    "what is mpgr",
    "what does mpgr",
    "explain mpgr",
    "explain $mpgr",
    "explain x402",
    "what is x402",
    "tokenized stock",
    "tokenized stocks",
    "base ecosystem",
    "how does mpgr hub",
    "how mpgr hub fits",
    "research the current base",
    "research base",
    "research $mpgr",
    "research mpgr",
  ],
  market_overview: [
    "whats moving in the market",
    "what's moving in the market",
    "moving in the market",
    "crypto markets",
    "analyze eth",
    "eth price",
    "btc price",
    "bitcoin",
    "market today",
  ],
};

const INTENT_PRIORITY: AgentIntent[] = [
  "open_rewards",
  "open_games",
  "open_profile",
  "open_staking",
  "open_premium",
  "open_leaderboard",
  "suggest_next_action",
  "portfolio_summary",
  "holder_tier",
  "premium_status",
  "season_progress",
  "staking_summary",
  "locked_tokens",
  "claimable_rewards",
  "xp_status",
  "referral_overview",
  "research_query",
  "market_overview",
  "general_help",
];

const GREETING_PATTERNS = ["hello", "hi", "hey", "hi there", "yo", "sup"];

function isGreeting(normalized: string): boolean {
  const wordCount = normalized.split(" ").filter(Boolean).length;
  return wordCount <= 3 && GREETING_PATTERNS.some((g) => normalized === g || normalized.startsWith(g + " "));
}

const X402_PAYMENT_ACTION_MARKERS = [
  "payment proposal",
  "payto",
  "resourceurl",
  "prepare a payment",
  "prepare payment",
  "pay this resource",
  "x402 resource",
] as const;

const X402_INFO_MARKERS = [
  "explain x402",
  "what is x402",
  "how x402",
  "how does x402",
  "x402 and how",
];

function looksLikeX402InformationalPrompt(normalized: string): boolean {
  return X402_INFO_MARKERS.some((marker) => normalized.includes(marker)) && !normalized.includes("https://");
}

function looksLikeX402PaymentPrompt(normalized: string): boolean {
  if (looksLikeX402InformationalPrompt(normalized)) return false;
  if (normalized.includes("https://") && normalized.includes("x402")) return true;
  return X402_PAYMENT_ACTION_MARKERS.some((marker) => normalized.includes(marker));
}

const TRADE_PROMPT_MARKERS = [
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
  "prepare a $",
  "prepare a quote",
  "buy $",
  "dex liquidity",
  "coinbase tokenized",
  "secondary-market",
  "secondary market",
] as const;

const TRADE_QUOTE_MARKERS = [
  "buy quote",
  "swap quote",
  "trade quote",
  "prepare a swap",
  "prepare a $",
  "prepare a quote",
  "buy $",
  "buy ",
  "swap ",
  "quote",
] as const;

const TRADE_SYMBOLS: { needle: string; ticker: string }[] = [
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

function looksLikeTradePrompt(normalized: string): boolean {
  return TRADE_PROMPT_MARKERS.some((marker) => normalized.includes(marker));
}

function looksLikeTradeQuotePrompt(normalized: string): boolean {
  return TRADE_QUOTE_MARKERS.some((marker) => normalized.includes(marker));
}

export function isTradePrompt(rawPrompt: string): boolean {
  return looksLikeTradePrompt(normalize(rawPrompt));
}

export function isTradeQuotePrompt(rawPrompt: string): boolean {
  return looksLikeTradeQuotePrompt(normalize(rawPrompt));
}

function normalizeSwapToken(raw: string): string {
  const t = raw.replace(/^\$/, "").toLowerCase();
  if (t === "eth" || t === "weth") return t === "weth" ? "WETH" : "ETH";
  if (t === "usdc") return "USDC";
  if (t === "mpgr") return "MPGR";
  return raw.toUpperCase();
}

export function extractCryptoSwapPair(rawPrompt: string): { fromToken: string; toToken: string } | null {
  const text = rawPrompt.toLowerCase();
  const token = "(?:\\$)?(eth|weth|usdc|mpgr)";

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
  const normalized = normalize(rawPrompt);
  return (
    normalized.includes("quote") ||
    normalized.includes("swap") ||
    normalized.includes("price") ||
    normalized.includes("how much") ||
    normalized.includes("what can i get")
  );
}

export function extractTradeSymbol(rawPrompt: string): string | null {
  const normalized = normalize(rawPrompt);
  for (const entry of TRADE_SYMBOLS) {
    if (normalized.includes(entry.needle)) return entry.ticker;
  }
  return null;
}

export function isTradeSellPrompt(rawPrompt: string): boolean {
  return /\bsell\b/.test(normalize(rawPrompt));
}

export function extractTradeHumanAmount(rawPrompt: string): string | null {
  const dollar = rawPrompt.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (dollar) return dollar[1];
  const usdc = rawPrompt.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:usdc|usd)\b/i);
  if (usdc) return usdc[1];
  const worth = rawPrompt.match(/\b([0-9]+(?:\.[0-9]+)?)\s+worth\b/i);
  if (worth) return worth[1];
  const units = rawPrompt.match(/\b([0-9]+(?:\.[0-9]+)?)\s+(?:shares?|tokens?|aaplc|coinc|tslac|nvdac)\b/i);
  if (units) return units[1];
  return null;
}

export function isX402PaymentPrompt(rawPrompt: string): boolean {
  return looksLikeX402PaymentPrompt(normalize(rawPrompt));
}

const TRANSFER_PROMPT_MARKERS = [
  "send ",
  "transfer ",
  "pay ",
  "base transfer",
  "plan a base transfer",
  "send eth",
  "send usdc",
  "send mpgr",
] as const;

const TRANSFER_PARSE_RE =
  /\b(?:send|transfer|sending|pay)\s+(?:of\s+)?([0-9]+(?:\.[0-9]+)?)\s+([a-z0-9.]{2,12}|0x[0-9a-f]{40})\s+to\s+(0x[0-9a-fA-F]{40}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.base\.eth)/i;

export function isTransferPrompt(rawPrompt: string): boolean {
  const normalized = normalize(rawPrompt);
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

const FOLLOW_UP_PATTERNS = [/^what about\b/, /^and\b/, /^also\b/, /^what else\b/, /^how about\b/];

const PRONOUN_REFERENCE_PATTERN = /\b(it|that|those|them)\b/;

function isFollowUp(normalized: string): boolean {
  if (FOLLOW_UP_PATTERNS.some((re) => re.test(normalized))) return true;
  const words = normalized.split(" ").filter(Boolean);
  // Long standalone questions that happen to contain "it" ("how MPGR HUB fits into it")
  // are not conversational follow-ups.
  if (words.length > 8) return false;
  return words.length <= 6 && PRONOUN_REFERENCE_PATTERN.test(normalized);
}

function looksLikeStandaloneResearch(normalized: string): boolean {
  return (
    normalized.includes("what is") ||
    normalized.includes("what does") ||
    normalized.includes("explain") ||
    normalized.includes("research") ||
    normalized.includes("how does") ||
    normalized.includes("tokenized stock") ||
    normalized.includes("base ecosystem")
  );
}

const RELATED_TOPICS: Partial<Record<AgentIntent, AgentIntent[]>> = {
  staking_summary: ["claimable_rewards"],
  locked_tokens: ["claimable_rewards"],
  premium_status: ["claimable_rewards", "xp_status"],
  season_progress: ["claimable_rewards", "xp_status"],
  holder_tier: ["portfolio_summary"],
};

function scoreIntents(normalized: string): { intent: AgentIntent; score: number }[] {
  return INTENT_PRIORITY.map((intent) => {
    const patterns = INTENT_PATTERNS[intent];
    const score = patterns.reduce((sum, pattern) => (normalized.includes(pattern) ? sum + 1 : sum), 0);
    return { intent, score };
  });
}

function bestIntent(normalized: string): AgentIntent | null {
  const scored = scoreIntents(normalized);
  let best: { intent: AgentIntent; score: number } | null = null;
  for (const entry of scored) {
    if (entry.score > 0 && (!best || entry.score > best.score)) {
      best = entry;
    }
  }
  return best ? best.intent : null;
}

interface DetectedIntent {
  intent: AgentIntent;
  greeting: boolean;
}

export function detectIntent(
  rawPrompt: string,
  previousIntent: AgentIntent | null,
  memoryContext?: ConversationMemoryContext
): DetectedIntent {
  const normalized = normalize(rawPrompt);

  if (isGreeting(normalized)) {
    return { intent: "general_help", greeting: true };
  }

  if (looksLikeX402InformationalPrompt(normalized)) {
    return { intent: "research_query", greeting: false };
  }

  if (looksLikeX402PaymentPrompt(normalized)) {
    return { intent: "general_help", greeting: false };
  }

  const direct = bestIntent(normalized);
  const followUp = isFollowUp(normalized);
  const standaloneResearch = looksLikeStandaloneResearch(normalized);

  if (direct) {
    if (
      !standaloneResearch &&
      followUp &&
      previousIntent &&
      previousIntent !== direct &&
      RELATED_TOPICS[previousIntent]?.includes(direct)
    ) {
      return { intent: previousIntent, greeting: false };
    }
    return { intent: direct, greeting: false };
  }

  if (standaloneResearch) {
    return { intent: "research_query", greeting: false };
  }

  if (previousIntent && followUp) {
    return { intent: previousIntent, greeting: false };
  }

  // Memory carry-over is only for short follow-ups, never for a new question.
  if (memoryContext && memoryContext.dominantRecentIntent && followUp) {
    return { intent: memoryContext.dominantRecentIntent, greeting: false };
  }

  return { intent: "general_help", greeting: false };
}

const NOT_CONNECTED_REPLY =
  "Connect your wallet first so I can read your Base wallet and $MPGR positions.";

const GREETING_REPLY =
  "Hey! I'm the MPGR Agent. Ask me to research $MPGR or Base, check your wallet/portfolio, prepare a swap or transfer, or inspect an x402 URL. XP, seasons, streaks, and claims live on the Rewards page.";

const GENERAL_HELP_REPLY =
  "I can help with research, markets, wallet/portfolio (ETH, USDC, $MPGR including staked/locked), Base swaps, tokenized stocks, and x402 prepare-only payments. XP, seasons, streaks, achievements, and claims are on the Rewards page.";

const X402_PAYMENT_HELP_REPLY =
  "This looks like an x402 paid-resource request. I will not sign or submit a payment from here. Include the https resource URL if you want it inspected — a proposal is only prepared for your explicit confirmation, and no funds move until you confirm.";

const TRADE_HELP_REPLY =
  "I can research Coinbase Tokenized Stocks on Base (B20) and prepare a Base swap quote for your review. Nothing is signed until you confirm in the app. Try \"Research COINc\" or \"Prepare a $10 USDC to COINc quote\".";

function notAvailable(topic: string): string {
  return "Your " + topic + " data isn't available yet — this usually means it's still loading. Give it a moment and ask again.";
}

function replyPortfolioSummary(ctx: AgentContext): string {
  if (!ctx.portfolio) return notAvailable("portfolio");
  const { walletBalance, stakedBalance, lockedBalance, totalHoldings } = ctx.portfolio;
  const eth = ctx.portfolio.nativeEth;
  const usdc = ctx.portfolio.usdc;
  const parts = [
    eth ? eth + " ETH" : null,
    formatCompactNumber(walletBalance) + " MPGR in wallet",
    usdc ? usdc + " USDC" : null,
    formatCompactNumber(stakedBalance) + " MPGR staked",
    formatCompactNumber(lockedBalance) + " MPGR locked",
  ].filter((part): part is string => Boolean(part));
  const exposure = formatCompactNumber(walletBalance + stakedBalance + lockedBalance);
  const progressHint =
    " XP, seasons, streaks, and claims are on the Rewards page — not part of this wallet summary.";
  return (
    "Wallet / portfolio on Base: " +
    parts.join(", ") +
    ". Total $MPGR exposure (wallet + staked + locked): " +
    exposure +
    " MPGR. Holder Score from those MPGR positions: " +
    formatCompactNumber(totalHoldings) +
    "." +
    progressHint
  );
}

function replyResearchQuery(): string {
  return (
    "MPGR HUB is a Base-native app around MoneyPaiger ($MPGR). The Agent researches Base and $MPGR, reads wallet/portfolio balances, and prepares transfers, swaps, tokenized-stock paths, and x402 payments — you confirm and sign. $MPGR is a fixed-supply utility token on Base mainnet (1,000,000,000 max, no inflation). Games and XP live on the Rewards page. This is product documentation, not financial advice."
  );
}

function replyMarketOverview(): string {
  return (
    "For live prices I only report feeds that are actually wired. $MPGR market data can be read from the Hub market ticker / market tool when available. ETH and BTC do not have a first-class news feed in this app — I will not invent a price or headline. Ask for a Base swap quote or trade_get_price for ETH/USDC/MPGR if you want a live quote path."
  );
}

function replyXPStatus(_ctx: AgentContext): string {
  return "XP, levels, and streaks are on the Rewards page — I do not track that here. Open Rewards to see your progress.";
}

function replyHolderTier(_ctx: AgentContext): string {
  return "Holder Tier and reputation live on Profile / Rewards. I can show wallet $MPGR, staked, and locked balances here.";
}

function replyPremiumStatus(_ctx: AgentContext): string {
  return "Premium tiers and XP multipliers are on the Premium / Rewards pages. Ask me about locked $MPGR or a token-lock prepare flow if you want an on-chain action.";
}

function replyClaimableRewards(_ctx: AgentContext): string {
  return "Claimable MPGR rewards and the reward vault are on the Rewards page. I will not claim anything from chat.";
}

function replyStakingSummary(ctx: AgentContext): string {
  if (!ctx.staking) return notAvailable("staking");
  const { totalStaked, earnedRewards, currentAPRPercent } = ctx.staking;
  if (totalStaked === 0) {
    return "You don't have any MPGR staked right now — head to the Staking page to start earning rewards.";
  }
  const aprNote = currentAPRPercent === null ? "" : " at the current " + currentAPRPercent + "% APR";
  return (
    "You have " +
    formatCompactNumber(totalStaked) +
    " MPGR staked" +
    aprNote +
    ", with " +
    formatCompactNumber(earnedRewards) +
    " MPGR in staking rewards ready to claim."
  );
}

function replyLockedTokens(ctx: AgentContext): string {
  if (!ctx.tokenLock) return notAvailable("Token Lock");
  const { totalLocked, activeLocksCount, upcomingUnlockAt } = ctx.tokenLock;
  if (activeLocksCount === 0) {
    return "You don't have any active locks right now. I can help prepare a token-lock transaction if you want one.";
  }
  const unlockNote = upcomingUnlockAt
    ? " Your next unlock is on " + formatUpcomingDate(upcomingUnlockAt) + "."
    : "";
  return (
    "You have " +
    formatCompactNumber(totalLocked) +
    " MPGR locked across " +
    activeLocksCount +
    " active lock" +
    (activeLocksCount === 1 ? "" : "s") +
    "." +
    unlockNote
  );
}

function replySeasonProgress(_ctx: AgentContext): string {
  return "Season points live on the Rewards page. I can help with wallet, $MPGR, swaps, or research instead.";
}

function replyReferralOverview(_ctx: AgentContext): string {
  return "Referral stats are on your Profile / Rewards pages, not in this Agent briefing.";
}

function replyOpenRewards(): string {
  return "Opening the Rewards page.";
}
function replyOpenGames(): string {
  return "Opening Games — check out what's available to play right now.";
}
function replyOpenProfile(): string {
  return "Opening your Profile.";
}
function replyOpenStaking(): string {
  return "Opening Staking — manage your staked MPGR and claim staking rewards.";
}
function replyOpenPremium(): string {
  return "Opening Premium — compare every tier and see what each one unlocks.";
}
function replyOpenLeaderboard(): string {
  return "Opening the Leaderboard page.";
}

function replySuggestNextAction(_ctx: AgentContext): string {
  return "Next step from here: review your Base wallet/portfolio, or open Rewards if you want XP and claims. I can prepare a swap or transfer if you want an on-chain action.";
}

const INTENT_HANDLERS: Record<AgentIntent, (ctx: AgentContext) => string> = {
  portfolio_summary: replyPortfolioSummary,
  xp_status: replyXPStatus,
  holder_tier: replyHolderTier,
  premium_status: replyPremiumStatus,
  claimable_rewards: replyClaimableRewards,
  staking_summary: replyStakingSummary,
  locked_tokens: replyLockedTokens,
  season_progress: replySeasonProgress,
  referral_overview: replyReferralOverview,
  general_help: () => GENERAL_HELP_REPLY,
  open_rewards: replyOpenRewards,
  open_games: replyOpenGames,
  open_profile: replyOpenProfile,
  open_staking: replyOpenStaking,
  open_premium: replyOpenPremium,
  open_leaderboard: replyOpenLeaderboard,
  suggest_next_action: replySuggestNextAction,
  research_query: replyResearchQuery,
  market_overview: replyMarketOverview,
};

const INTENT_LABELS: Record<AgentIntent, string> = {
  portfolio_summary: "your portfolio",
  xp_status: "your XP and level progress",
  holder_tier: "your Holder Tier",
  premium_status: "Premium",
  claimable_rewards: "claimable rewards",
  staking_summary: "staking",
  locked_tokens: "locked tokens",
  season_progress: "Season Pass",
  referral_overview: "referrals",
  general_help: "MPGR HUB",
  open_rewards: "Rewards",
  open_games: "Games",
  open_profile: "your Profile",
  open_staking: "Staking",
  open_premium: "Premium",
  open_leaderboard: "the Leaderboard",
  suggest_next_action: "what to do next",
  research_query: "MPGR HUB research",
  market_overview: "markets",
};

function buildGreetingReply(memoryContext?: ConversationMemoryContext): string {
  if (!memoryContext || !memoryContext.isReturningUser) return GREETING_REPLY;
  const topic = memoryContext.favoriteTopics[0];
  const topicNote = topic
    ? " Want to check in on " + INTENT_LABELS[topic] + " again, or ask about something else?"
    : "";
  return "Welcome back! I have your wallet and $MPGR on-chain context loaded." + topicNote;
}

function buildRecallNote(intent: AgentIntent, memoryContext?: ConversationMemoryContext): string | null {
  if (!memoryContext) return null;

  if (intent === "general_help") {
    const topic = memoryContext.favoriteTopics[0];
    return topic
      ? "You've mostly been asking about " + INTENT_LABELS[topic] + " — happy to dig into that again, or anything else."
      : null;
  }

  const delta = memoryContext.walletDelta;
  if (!delta) return null;

  switch (intent) {
    case "xp_status":
      return delta.xpGained !== null && delta.xpGained > 0
        ? "Since we last talked, you've gained " + formatCompactNumber(delta.xpGained) + " XP."
        : null;
    case "portfolio_summary":
      return delta.holdingsChange !== null && delta.holdingsChange !== 0
        ? "Your total holdings are " +
            (delta.holdingsChange > 0 ? "up" : "down") +
            " " +
            formatCompactNumber(Math.abs(delta.holdingsChange)) +
            " MPGR since last time."
        : null;
    case "holder_tier":
      return delta.tierChanged && delta.currentTierLabel
        ? "You've moved up to " + delta.currentTierLabel + " Holder Tier since we last talked — nice progress."
        : null;
    case "staking_summary":
      return delta.stakedChange !== null && delta.stakedChange !== 0
        ? "Your staked balance is " +
            (delta.stakedChange > 0 ? "up" : "down") +
            " " +
            formatCompactNumber(Math.abs(delta.stakedChange)) +
            " MPGR since last time."
        : null;
    case "locked_tokens":
      return delta.lockedChange !== null && delta.lockedChange !== 0
        ? "Your locked balance is " +
            (delta.lockedChange > 0 ? "up" : "down") +
            " " +
            formatCompactNumber(Math.abs(delta.lockedChange)) +
            " MPGR since last time."
        : null;
    case "season_progress":
      return delta.seasonPointsChange !== null && delta.seasonPointsChange > 0
        ? "You've earned " +
            formatCompactNumber(delta.seasonPointsChange) +
            " more season points since we last talked."
        : null;
    default:
      return null;
  }
}

export function generateIntelligentReply(
  prompt: string,
  context: AgentContext,
  previousIntent: AgentIntent | null,
  memoryContext?: ConversationMemoryContext
): AgentIntelligenceResult {
  const { intent, greeting } = detectIntent(prompt, previousIntent, memoryContext);

  if (!context.isConnected && intent !== "research_query" && intent !== "market_overview" && intent !== "general_help") {
    return { intent: "general_help", reply: NOT_CONNECTED_REPLY, actions: [], highlights: [], followUps: [] };
  }

  if (looksLikeX402PaymentPrompt(normalize(prompt))) {
    return {
      intent: "general_help",
      reply: X402_PAYMENT_HELP_REPLY,
      actions: [],
      highlights: [],
      followUps: getFollowUpPrompts("general_help"),
    };
  }

  if (isCryptoSwapQuotePrompt(prompt)) {
    return {
      intent: "general_help",
      reply:
        "I can fetch a live Base swap quote for ETH/WETH/USDC/MPGR via the existing trade price path. Nothing is signed until you confirm a prepared swap.",
      actions: [],
      highlights: [],
      followUps: getFollowUpPrompts("general_help"),
    };
  }

  if (looksLikeTradePrompt(normalize(prompt)) && extractTradeSymbol(prompt)) {
    return {
      intent: "general_help",
      reply: TRADE_HELP_REPLY,
      actions: [],
      highlights: [],
      followUps: getFollowUpPrompts("general_help"),
    };
  }

  if (greeting) {
    const reply = buildGreetingReply(memoryContext);
    return { intent, reply, actions: [], highlights: [], followUps: getFollowUpPrompts(intent) };
  }

  const baseReply = INTENT_HANDLERS[intent](context);
  const recallNote = buildRecallNote(intent, memoryContext);
  const reply = recallNote ? baseReply + " " + recallNote : baseReply;

  return {
    intent,
    reply,
    actions: getAgentActions(intent, context),
    highlights: getAgentHighlights(intent, context),
    followUps: getFollowUpPrompts(intent),
  };
}
