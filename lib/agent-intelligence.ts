import { formatCompactNumber } from "@/lib/format";
import type { AgentContext } from "@/lib/agent-context";

// lib/format.ts's formatRelativeTime is past-only ("2 days ago",
// "Yesterday") — it produces incorrect output for a future unlock date, so
// it's not reused here. This mirrors the exact date formatting
// components/ui/TokenLockSummaryCard.tsx already uses for the same
// upcomingUnlockAt field, so the agent's answer matches what the Token
// Lock page shows.
function formatUpcomingDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Phase 3A.2 — MPGR Agent Intelligence Layer, reasoning layer.
//
// Deterministic, local, keyword/pattern-scored intent detection + reply
// generation. No model, no network call — this is the piece that gets
// swapped out wholesale in Phase 3B for a real model call. Everything
// downstream (hooks/useAgentChat.ts, lib/agent-engine.ts, and every UI
// component) only ever sees `{ intent, reply }`, so that swap won't
// require touching anything outside this file plus its call site in
// lib/agent-engine.ts.
//
// "XP Status" and "Level Progress" are intentionally the SAME intent here
// (`xp_status`) rather than two — level is directly derived from XP via
// getLevelProgress(xp) in lib/xp-engine.ts, so there is no second data
// source that would justify a separate branch. This also matches the
// product spec's own example, where "How much XP?", "What level am I?",
// "My XP", and "Show progress" are all expected to resolve to one intent.

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
  | "general_help";

export interface AgentIntelligenceResult {
  intent: AgentIntent;
  reply: string;
}

// --- Normalization -----------------------------------------------------

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[?.!,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Intent pattern bank -------------------------------------------------
// Multiple phrasings per intent, matched as substrings against the
// normalized prompt. Longer/more specific phrases are included alongside
// short single-word cues so a match can be scored, not just detected.

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
    "xp",
    "experience point",
    "what level",
    "my level",
    "level am i",
    "show progress",
    "level progress",
    "how much xp",
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
  ],
  claimable_rewards: ["claimable", "claim my reward", "reward", "rewards page", "what can i claim"],
  staking_summary: ["stak", "staking position", "staking reward"],
  locked_tokens: ["locked", "token lock", "my lock", "unlock", "lock period"],
  season_progress: ["season pass", "season point", "season level", "season"],
  referral_overview: ["referral", "invite", "refer a friend", "my invites"],
  general_help: ["help", "what can you do", "what do you do"],
};

// Fixed iteration order used as the tie-break when two intents score
// equally — first match in this list wins.
const INTENT_PRIORITY: AgentIntent[] = [
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
  return wordCount <= 3 && GREETING_PATTERNS.some((g) => normalized === g || normalized.startsWith(`${g} `));
}

// A short, connector-led message ("What about rewards?", "And staking?")
// is treated as a follow-up to the previous topic rather than a fresh,
// standalone question.
const FOLLOW_UP_PATTERNS = [/^what about\b/, /^and\b/, /^also\b/, /^what else\b/, /^how about\b/];

function isFollowUp(normalized: string): boolean {
  const wordCount = normalized.split(" ").filter(Boolean).length;
  return FOLLOW_UP_PATTERNS.some((re) => re.test(normalized)) || wordCount <= 3;
}

// When a follow-up's own best match is one of these "generic" intents,
// but the previous turn was on a more specific related topic, stay on the
// previous topic instead. This is what makes "staking" -> "What about
// rewards?" resolve to staking rewards (via the staking_summary handler,
// which already surfaces claimable staking rewards) rather than the
// generic Rewards-page claimable_rewards handler.
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
    if (entry.score > 0 && (!best || entry.score > best.score)) best = entry;
  }
  return best?.intent ?? null;
}

interface DetectedIntent {
  intent: AgentIntent;
  greeting: boolean;
}

export function detectIntent(rawPrompt: string, previousIntent: AgentIntent | null): DetectedIntent {
  const normalized = normalize(rawPrompt);

  if (isGreeting(normalized)) {
    return { intent: "general_help", greeting: true };
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

  return { intent: "general_help", greeting: false };
}

// --- Reply generation ----------------------------------------------------
// Every handler checks its slice of AgentContext for null before reading
// it, and explains — rather than guesses — when data isn't available yet.
// Nothing here is ever hardcoded to a plausible-looking number.

const NOT_CONNECTED_REPLY =
  "Connect your wallet first so I can read your MPGR HUB data — XP, staking, Holder Tier, Premium, and more.";

const GREETING_REPLY =
  "Hey! I'm the MPGR Agent. Ask me about your XP, staking, Holder Tier, Premium status, locked tokens, Season Pass, or claimable rewards.";

const GENERAL_HELP_REPLY =
  "I can help with: Portfolio Summary, XP & Level Progress, Holder Tier, Premium Status, Claimable Rewards, Staking Summary, Locked Tokens, Season Progress, and Referral Overview. Just ask — for example, \"What's my Holder Tier?\" or \"How much XP do I have?\"";

function notAvailable(topic: string): string {
  return `Your ${topic} data isn't available yet — this usually means it's still loading. Give it a moment and ask again.`;
}

function replyPortfolioSummary(ctx: AgentContext): string {
  if (!ctx.portfolio) return notAvailable("portfolio");
  const { walletBalance, stakedBalance, lockedBalance, totalHoldings, claimableRewards } = ctx.portfolio;
  const claimableNote =
    claimableRewards > 0
      ? ` You also have ${formatCompactNumber(claimableRewards)} MPGR in claimable rewards waiting to be collected.`
      : "";
  return `Here's your portfolio: ${formatCompactNumber(walletBalance)} MPGR in your wallet, ${formatCompactNumber(
    stakedBalance
  )} staked, and ${formatCompactNumber(lockedBalance)} locked — ${formatCompactNumber(
    totalHoldings
  )} MPGR total Holder Score.${claimableNote}`;
}

function replyXPStatus(ctx: AgentContext): string {
  if (!ctx.xp) return notAvailable("XP");
  const { xp, level, nextLevel, xpIntoLevel, xpNeededForLevel, progress, streak } = ctx.xp;
  return `You're Level ${level} with ${formatCompactNumber(xp)} XP total — ${xpIntoLevel}/${xpNeededForLevel} XP into this level (${progress}% of the way to Level ${nextLevel}). Current daily streak: ${streak} day${streak === 1 ? "" : "s"}.`;
}

function replyHolderTier(ctx: AgentContext): string {
  if (!ctx.holderTier) return notAvailable("Holder Tier");
  const { tierLabel, totalScore, nextTierLabel, progressToNextTier, amountToNextTier, votingWeight, reputationScore } =
    ctx.holderTier;

  if (!tierLabel) {
    return "You haven't reached a Holder Tier yet — hold, stake, or lock MPGR to start climbing toward Bronze, the first tier.";
  }

  const nextNote = nextTierLabel
    ? ` You need ${formatCompactNumber(amountToNextTier)} more MPGR to reach ${nextTierLabel} (${progressToNextTier}% of the way there).`
    : " You've reached Diamond, the highest Holder Tier.";

  return `You're currently ${tierLabel} Holder Tier with a Holder Score of ${formatCompactNumber(
    totalScore
  )}.${nextNote} Your governance voting weight is ${formatCompactNumber(votingWeight)} and community reputation is ${formatCompactNumber(reputationScore)}.`;
}

function replyPremiumStatus(ctx: AgentContext): string {
  if (!ctx.premium) return notAvailable("Premium");
  const { isPremium, tierLabel, xpMultiplier, rewardsMultiplier, nextTierLabel, progressToNextTier, amountToNextTier } =
    ctx.premium;

  if (!isPremium) {
    return nextTierLabel
      ? `You're not on a Premium tier yet — lock ${formatCompactNumber(amountToNextTier)} more MPGR to unlock ${nextTierLabel} and boost your XP and Rewards multipliers.`
      : "You're not on a Premium tier yet — lock MPGR in Token Lock to unlock a Premium tier and boost your XP and Rewards multipliers.";
  }

  const nextNote = nextTierLabel
    ? ` ${formatCompactNumber(amountToNextTier)} more locked MPGR gets you to ${nextTierLabel} (${progressToNextTier}% of the way there).`
    : " You're at the top Premium tier.";

  return `You're on the ${tierLabel} Premium tier — ${xpMultiplier}× XP and ${rewardsMultiplier}× Rewards multiplier.${nextNote}`;
}

function replyClaimableRewards(ctx: AgentContext): string {
  if (!ctx.rewards) return notAvailable("rewards");
  const { claimableTotal, totalClaimed } = ctx.rewards;
  const stakingNote =
    ctx.staking && ctx.staking.claimableRewards > 0
      ? ` That's separate from the ${formatCompactNumber(ctx.staking.claimableRewards)} MPGR in staking rewards also ready to claim.`
      : "";
  return `You have ${formatCompactNumber(claimableTotal)} MPGR claimable right now on the Rewards page, and ${formatCompactNumber(
    totalClaimed
  )} MPGR claimed lifetime.${stakingNote}`;
}

function replyStakingSummary(ctx: AgentContext): string {
  if (!ctx.staking) return notAvailable("staking");
  const { totalStaked, claimableRewards, activePositionsCount } = ctx.staking;
  if (activePositionsCount === 0) {
    return "You don't have any active staking positions right now — head to the Staking page to start earning rewards.";
  }
  return `You have ${formatCompactNumber(totalStaked)} MPGR staked across ${activePositionsCount} active position${activePositionsCount === 1 ? "" : "s"}, with ${formatCompactNumber(claimableRewards)} MPGR in staking rewards ready to claim.`;
}

function replyLockedTokens(ctx: AgentContext): string {
  if (!ctx.tokenLock) return notAvailable("Token Lock");
  const { totalLocked, activeLocksCount, upcomingUnlockAt } = ctx.tokenLock;
  if (activeLocksCount === 0) {
    return "You don't have any active locks right now — locking MPGR also contributes to your Premium tier and Holder Score.";
  }
  const unlockNote = upcomingUnlockAt ? ` Your next unlock is on ${formatUpcomingDate(upcomingUnlockAt)}.` : "";
  return `You have ${formatCompactNumber(totalLocked)} MPGR locked across ${activeLocksCount} active lock${activeLocksCount === 1 ? "" : "s"}.${unlockNote}`;
}

function replySeasonProgress(ctx: AgentContext): string {
  if (!ctx.season) return notAvailable("Season Pass");
  const { seasonNumber, seasonPoints, level, progress } = ctx.season;
  return `Season ${seasonNumber}: you're at Level ${level} with ${formatCompactNumber(seasonPoints)} season points (${progress}% of the way to the next level).`;
}

function replyReferralOverview(ctx: AgentContext): string {
  if (!ctx.xp) return notAvailable("referral");
  const { referralCount } = ctx.xp;
  if (referralCount === 0) {
    return "You haven't referred anyone yet — share your referral link from your Profile page to start earning referral XP.";
  }
  return `You've referred ${referralCount} friend${referralCount === 1 ? "" : "s"} so far. Share your referral link from your Profile page to earn even more.`;
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
};

// Single entry point. Phase 3B swap point: this function's body becomes an
// async model call; its signature (prompt + context + previousIntent) can
// stay the same since AgentContext already carries everything a model
// would need to ground its answer in real app state.
export function generateIntelligentReply(
  prompt: string,
  context: AgentContext,
  previousIntent: AgentIntent | null
): AgentIntelligenceResult {
  if (!context.isConnected) {
    return { intent: "general_help", reply: NOT_CONNECTED_REPLY };
  }

  const { intent, greeting } = detectIntent(prompt, previousIntent);
  if (greeting) {
    return { intent, reply: GREETING_REPLY };
  }

  return { intent, reply: INTENT_HANDLERS[intent](context) };
}
