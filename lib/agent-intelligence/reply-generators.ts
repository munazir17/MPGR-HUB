import { formatCompactNumber } from "@/lib/format";
import type { AgentContext } from "@/lib/agent-context";
import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";
import type { AgentIntent } from "./types";

export function formatUpcomingDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const NOT_CONNECTED_REPLY =
  "Connect your wallet first so I can read your MPGR HUB data — XP, staking, Holder Tier, Premium, and more.";

export const GREETING_REPLY =
  "Hey! I'm the MPGR Agent. Ask me about your XP, staking, Holder Tier, Premium status, locked tokens, Season Pass, or claimable rewards.";

export const GENERAL_HELP_REPLY =
  "I can help with: Portfolio Summary, XP & Level Progress, Holder Tier, Premium Status, Claimable Rewards, Staking Summary, Locked Tokens, Season Progress, and Referral Overview. Just ask — for example, \"What's my Holder Tier?\" or \"How much XP do I have?\" I can also open a page for you directly — try \"open rewards\" or \"what should I do next?\"";

export const X402_PAYMENT_HELP_REPLY =
  "This looks like an x402 paid-resource request. I will not sign or submit a payment from here. Include the https resource URL if you want it inspected — a proposal is only prepared for your explicit confirmation, and no funds move until you confirm.";

export const TRADE_HELP_REPLY =
  "I can research Coinbase Tokenized Stocks on Base (B20) and prepare a Base swap quote for your review. Nothing is signed until you confirm in the app. Try \"Research COINc\" or \"Prepare a $10 USDC to COINc quote\".";

export function notAvailable(topic: string): string {
  return "Your " + topic + " data isn't available yet — this usually means it's still loading. Give it a moment and ask again.";
}

export function replyPortfolioSummary(ctx: AgentContext): string {
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
    " XP, Holder Tier, Season Points, and referrals are account progress — ask separately if you want those. Rewards details are available on the Rewards page.";
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

export function replyResearchQuery(): string {
  return (
    "MPGR HUB is a Base-native app around MoneyPaiger ($MPGR): an AI agent that can research and prepare onchain actions, MPGR Run, XP/seasons, staking, token lock, and a reward vault. $MPGR is a fixed-supply utility token on Base mainnet (1,000,000,000 max, no inflation). The Agent prepares transfers, swaps, tokenized-stock paths, and x402 payments — you confirm and sign. Base is the only production chain. This is product documentation, not financial advice."
  );
}

export function replyMarketOverview(): string {
  return (
    "For live prices I only report feeds that are actually wired. $MPGR market data can be read from the Hub market ticker / market tool when available. ETH and BTC do not have a first-class news feed in this app — I will not invent a price or headline. Ask for a Base swap quote or trade_get_price for ETH/USDC/MPGR if you want a live quote path."
  );
}

export function replyXPStatus(ctx: AgentContext): string {
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

export function replyHolderTier(ctx: AgentContext): string {
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

export function replyPremiumStatus(ctx: AgentContext): string {
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

export function replyClaimableRewards(ctx: AgentContext): string {
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

export function replyStakingSummary(ctx: AgentContext): string {
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

export function replyLockedTokens(ctx: AgentContext): string {
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

export function replySeasonProgress(ctx: AgentContext): string {
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

export function replyReferralOverview(ctx: AgentContext): string {
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

export function replyOpenRewards(): string {
  return "Opening Rewards for you — here's your claimable balance and claim history.";
}
export function replyOpenGames(): string {
  return "Opening Games — check out what's available to play right now.";
}
export function replyOpenProfile(): string {
  return "Opening your Profile — XP, Holder Tier, Premium, and Season Pass all in one place.";
}
export function replyOpenStaking(): string {
  return "Opening Staking — manage your staked MPGR and claim staking rewards.";
}
export function replyOpenPremium(): string {
  return "Opening Premium — compare every tier and see what each one unlocks.";
}
export function replyOpenLeaderboard(): string {
  return "Opening the Leaderboard — see how you rank community-wide.";
}

export function replySuggestNextAction(ctx: AgentContext): string {
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

export const INTENT_HANDLERS: Record<AgentIntent, (ctx: AgentContext) => string> = {
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

export const INTENT_LABELS: Record<AgentIntent, string> = {
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

export function buildGreetingReply(memoryContext?: ConversationMemoryContext): string {
  if (!memoryContext || !memoryContext.isReturningUser) return GREETING_REPLY;
  const topic = memoryContext.favoriteTopics[0];
  const topicNote = topic
    ? " Want to check in on " + INTENT_LABELS[topic] + " again, or ask about something else?"
    : "";
  return "Welcome back! I've got your MPGR HUB context loaded — XP, staking, Holder Tier, and more." + topicNote;
}

export function buildRecallNote(intent: AgentIntent, memoryContext?: ConversationMemoryContext): string | null {
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
