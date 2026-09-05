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
  | "suggest_next_action";

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
    "portfolio",
    "my balance",
    "total holdings",
    "everything i have",
    "net worth",
    "overview of my",
    "summary of my mpgr",
    "how much mpgr do i have",
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
  claimable_rewards: ["claimable", "claim my reward", "reward", "rewards page", "what can i claim"],
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
  "general_help",
];

const GREETING_PATTERNS = ["hello", "hi", "hey", "hi there", "yo", "sup"];

function isGreeting(normalized: string): boolean {
  const wordCount = normalized.split(" ").filter(Boolean).length;
  return wordCount <= 3 && GREETING_PATTERNS.some((g) => normalized === g || normalized.startsWith(g + " "));
}

const X402_PAYMENT_PROMPT_MARKERS = [
  "x402",
  "payment proposal",
  "payto",
  "resourceurl",
  "https://",
] as const;

function looksLikeX402PaymentPrompt(normalized: string): boolean {
  return X402_PAYMENT_PROMPT_MARKERS.some((marker) => normalized.includes(marker));
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
  "current price",
  "price of",
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
  return FOLLOW_UP_PATTERNS.some((re) => re.test(normalized)) || PRONOUN_REFERENCE_PATTERN.test(normalized);
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

  if (looksLikeX402PaymentPrompt(normalized)) {
    return { intent: "general_help", greeting: false };
  }

  const direct = bestIntent(normalized);
  const followUp = isFollowUp(normalized);

  if (direct) {
    if (followUp && previousIntent && previousIntent !== direct && RELATED_TOPICS[previousIntent]?.includes(direct)) {
      return { intent: previousIntent, greeting: false };
    }
    return { intent: direct, greeting: false };
  }

  if (previousIntent && followUp) {
    return { intent: previousIntent, greeting: false };
  }

  if (memoryContext && memoryContext.dominantRecentIntent) {
    return { intent: memoryContext.dominantRecentIntent, greeting: false };
  }

  return { intent: "general_help", greeting: false };
}

const NOT_CONNECTED_REPLY =
  "Connect your wallet first so I can read your MPGR HUB data — XP, staking, Holder Tier, Premium, and more.";

const GREETING_REPLY =
  "Hey! I'm the MPGR Agent. Ask me about your XP, staking, Holder Tier, Premium status, locked tokens, Season Pass, or claimable rewards.";

const GENERAL_HELP_REPLY =
  "I can help with: Portfolio Summary, XP & Level Progress, Holder Tier, Premium Status, Claimable Rewards, Staking Summary, Locked Tokens, Season Progress, and Referral Overview. Just ask — for example, \"What's my Holder Tier?\" or \"How much XP do I have?\" I can also open a page for you directly — try \"open rewards\" or \"what should I do next?\"";

const X402_PAYMENT_HELP_REPLY =
  "This looks like an x402 paid-resource request. I will not sign or submit a payment from here. Include the https resource URL if you want it inspected — a proposal is only prepared for your explicit confirmation, and no funds move until you confirm.";

const TRADE_HELP_REPLY =
  "I can research Coinbase Tokenized Stocks on Base (B20) and prepare a Base swap quote for your review. Nothing is signed until you confirm in the app. Try \"Research COINc\" or \"Prepare a $10 USDC to COINc quote\".";

function notAvailable(topic: string): string {
  return "Your " + topic + " data isn't available yet — this usually means it's still loading. Give it a moment and ask again.";
}

function replyPortfolioSummary(ctx: AgentContext): string {
  if (!ctx.portfolio) return notAvailable("portfolio");
  const { walletBalance, stakedBalance, lockedBalance, totalHoldings, claimableRewards } = ctx.portfolio;
  const claimableNote =
    claimableRewards > 0
      ? " You also have " + formatCompactNumber(claimableRewards) + " MPGR in claimable rewards waiting to be collected."
      : "";
  return (
    "Here's your portfolio: " +
    formatCompactNumber(walletBalance) +
    " MPGR in your wallet, " +
    formatCompactNumber(stakedBalance) +
    " staked, and " +
    formatCompactNumber(lockedBalance) +
    " locked — " +
    formatCompactNumber(totalHoldings) +
    " MPGR total Holder Score." +
    claimableNote
  );
}

function replyXPStatus(ctx: AgentContext): string {
  if (!ctx.xp) return notAvailable("XP");
  const { xp, level, nextLevel, xpIntoLevel, xpNeededForLevel, progress, streak } = ctx.xp;
  return (
    "You're Level " +
    level +
    " with " +
    formatCompactNumber(xp) +
    " XP total — " +
    xpIntoLevel +
    "/" +
    xpNeededForLevel +
    " XP into this level (" +
    progress +
    "% of the way to Level " +
    nextLevel +
    "). Current daily streak: " +
    streak +
    " day" +
    (streak === 1 ? "" : "s") +
    "."
  );
}

function replyHolderTier(ctx: AgentContext): string {
  if (!ctx.holderTier) return notAvailable("Holder Tier");
  const { tierLabel, totalScore, nextTierLabel, progressToNextTier, amountToNextTier, votingWeight, reputationScore } =
    ctx.holderTier;

  if (!tierLabel) {
    return "You haven't reached a Holder Tier yet — hold, stake, or lock MPGR to start climbing toward Bronze, the first tier.";
  }

  const nextNote = nextTierLabel
    ? " You need " +
      formatCompactNumber(amountToNextTier) +
      " more MPGR to reach " +
      nextTierLabel +
      " (" +
      progressToNextTier +
      "% of the way there)."
    : " You've reached Diamond, the highest Holder Tier.";

  return (
    "You're currently " +
    tierLabel +
    " Holder Tier with a Holder Score of " +
    formatCompactNumber(totalScore) +
    "." +
    nextNote +
    " Your governance voting weight is " +
    formatCompactNumber(votingWeight) +
    " and community reputation is " +
    formatCompactNumber(reputationScore) +
    "."
  );
}

function replyPremiumStatus(ctx: AgentContext): string {
  if (!ctx.premium) return notAvailable("Premium");
  const { isPremium, tierLabel, xpMultiplier, rewardsMultiplier, nextTierLabel, progressToNextTier, amountToNextTier } =
    ctx.premium;

  if (!isPremium) {
    return nextTierLabel
      ? "You're not on a Premium tier yet — lock " +
          formatCompactNumber(amountToNextTier) +
          " more MPGR to unlock " +
          nextTierLabel +
          " and boost your XP and Rewards multipliers."
      : "You're not on a Premium tier yet — lock MPGR in Token Lock to unlock a Premium tier and boost your XP and Rewards multipliers.";
  }

  const nextNote = nextTierLabel
    ? " " +
      formatCompactNumber(amountToNextTier) +
      " more locked MPGR gets you to " +
      nextTierLabel +
      " (" +
      progressToNextTier +
      "% of the way there)."
    : " You're at the top Premium tier.";

  return (
    "You're on the " +
    tierLabel +
    " Premium tier — " +
    xpMultiplier +
    "× XP and " +
    rewardsMultiplier +
    "× Rewards multiplier." +
    nextNote
  );
}

function replyClaimableRewards(ctx: AgentContext): string {
  if (!ctx.rewards) return notAvailable("rewards");
  const { claimableTotal, totalClaimed } = ctx.rewards;
  const stakingNote =
    ctx.staking && ctx.staking.earnedRewards > 0
      ? " That's separate from the " +
        formatCompactNumber(ctx.staking.earnedRewards) +
        " MPGR in staking rewards also ready to claim."
      : "";
  return (
    "You have " +
    formatCompactNumber(claimableTotal) +
    " MPGR claimable right now on the Rewards page, and " +
    formatCompactNumber(totalClaimed) +
    " MPGR claimed lifetime." +
    stakingNote
  );
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
    return "You don't have any active locks right now — locking MPGR also contributes to your Premium tier and Holder Score.";
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

function replySeasonProgress(ctx: AgentContext): string {
  if (!ctx.season) return notAvailable("Season Pass");
  const { seasonNumber, seasonPoints, level, progress } = ctx.season;
  return (
    "Season " +
    seasonNumber +
    ": you're at Level " +
    level +
    " with " +
    formatCompactNumber(seasonPoints) +
    " season points (" +
    progress +
    "% of the way to the next level)."
  );
}

function replyReferralOverview(ctx: AgentContext): string {
  if (!ctx.xp) return notAvailable("referral");
  const { referralCount } = ctx.xp;
  if (referralCount === 0) {
    return "You haven't referred anyone yet — share your referral link from your Profile page to start earning referral XP.";
  }
  return (
    "You've referred " +
    referralCount +
    " friend" +
    (referralCount === 1 ? "" : "s") +
    " so far. Share your referral link from your Profile page to earn even more."
  );
}

function replyOpenRewards(): string {
  return "Opening Rewards for you — here's your claimable balance and claim history.";
}
function replyOpenGames(): string {
  return "Opening Games — check out what's available to play right now.";
}
function replyOpenProfile(): string {
  return "Opening your Profile — XP, Holder Tier, Premium, and Season Pass all in one place.";
}
function replyOpenStaking(): string {
  return "Opening Staking — manage your staked MPGR and claim staking rewards.";
}
function replyOpenPremium(): string {
  return "Opening Premium — compare every tier and see what each one unlocks.";
}
function replyOpenLeaderboard(): string {
  return "Opening the Leaderboard — see how you rank community-wide.";
}

function replySuggestNextAction(ctx: AgentContext): string {
  if (ctx.rewards && ctx.rewards.claimableTotal > 0) {
    return (
      "You have " +
      formatCompactNumber(ctx.rewards.claimableTotal) +
      " MPGR claimable right now — claiming your rewards is the best next move."
    );
  }
  if (ctx.staking && ctx.staking.earnedRewards > 0) {
    return (
      "You have " +
      formatCompactNumber(ctx.staking.earnedRewards) +
      " MPGR in staking rewards ready to claim — that's your best next move."
    );
  }
  if (ctx.premium && !ctx.premium.isPremium) {
    return "You're not on a Premium tier yet — locking MPGR to unlock Premium is a great next step for boosting your multipliers.";
  }
  if (ctx.staking && ctx.staking.totalStaked === 0) {
    return "You don't have any MPGR staked — starting to stake MPGR is a solid next move to start earning rewards.";
  }
  if (ctx.tokenLock && ctx.tokenLock.activeLocksCount === 0) {
    return "You don't have any active token locks — locking some MPGR boosts your Premium tier and Holder Score.";
  }
  return "You're in good shape across the board — check your portfolio summary to see the full picture.";
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
};

function buildGreetingReply(memoryContext?: ConversationMemoryContext): string {
  if (!memoryContext || !memoryContext.isReturningUser) return GREETING_REPLY;
  const topic = memoryContext.favoriteTopics[0];
  const topicNote = topic
    ? " Want to check in on " + INTENT_LABELS[topic] + " again, or ask about something else?"
    : "";
  return "Welcome back! I've got your MPGR HUB context loaded — XP, staking, Holder Tier, and more." + topicNote;
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
  if (!context.isConnected) {
    return { intent: "general_help", reply: NOT_CONNECTED_REPLY, actions: [], highlights: [], followUps: [] };
  }

  const { intent, greeting } = detectIntent(prompt, previousIntent, memoryContext);

  if (looksLikeX402PaymentPrompt(normalize(prompt))) {
    return {
      intent: "general_help",
      reply: X402_PAYMENT_HELP_REPLY,
      actions: [],
      highlights: [],
      followUps: getFollowUpPrompts("general_help"),
    };
  }

  if (looksLikeTradePrompt(normalize(prompt))) {
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
