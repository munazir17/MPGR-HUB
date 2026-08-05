import type { AgentIntent } from "@/lib/agent-intelligence";
import type { AgentContext } from "@/lib/agent-context";
import { formatCompactNumber } from "@/lib/format";
import { PREMIUM_TIERS, PREMIUM_REWARDS_MULTIPLIER, PREMIUM_XP_MULTIPLIER } from "@/lib/premium-config";

// Phase 3A.3 — Smart Actions & Conversational UX.
//
// This module derives two extra pieces of UI-ready data from the same
// AgentContext that lib/agent-intelligence.ts already grounds its text
// replies in: tappable "smart actions" (deep links into the relevant
// feature page) and "highlight chips" (compact key-stat callouts). It also
// owns the context-aware follow-up prompt suggestions shown after a reply.
//
// IMPORTANT — serialization boundary: AgentAction/AgentHighlight carry an
// `icon` as a string key (AgentIconKey), never a LucideIcon component
// reference. hooks/useAgentChat.ts -> lib/agent-engine.ts persists every
// assistant message (including its actions/highlights) to localStorage via
// lib/storage.ts's JSON.stringify. A component reference is a function and
// does not survive that round-trip, so resolving the key to an actual icon
// component only happens in the UI layer
// (components/features/agent/agent-icon-map.ts). Keep it that way — do not
// import lucide-react components into this file. The exact same rule now
// applies to Phase 3D's SmartCardPayload/SmartActionPayload below.
//
// Routes below were verified against the actual app/ tree, not assumed:
// Season Pass status here comes from useSeasonPass (season_progress
// intent), which is the /season-pass page's data source — NOT /season,
// which is a separate, XP-engine-driven season-points page. Token Lock
// lives at /app/token-lock (matches components/Navbar.tsx's own link).
//
// Phase 3D addendum — Smart Actions & AI Automation. Three additions,
// none of which touch a single line above this comment block:
//   1. SmartCardType/SmartCardStat/SmartCardPayload + getSmartCard(): a
//      compact, reusable "Smart Response Card" built from the exact same
//      AgentContext slice each highlightsX()/actionsX() function below
//      already reads — no new data source, no duplicated aggregation.
//   2. SmartActionPayload + buildSmartActionPayload(): the structured
//      `{ intent, action, target }` shape the product spec asks for,
//      derived from getSmartCard()/getAgentActions() rather than
//      recomputed — a thin reshape of data this file already produces.
//   3. Two new intents (compare_premium, suggest_next_action) and their
//      action/highlight/follow-up builders, registered into the same
//      Record<AgentIntent, ...> maps every existing intent already goes
//      through.
// lib/architecture/actions/action-types.ts imports FROM this file
// (one-way), never the other way around — this file has zero dependency
// on the Action Engine.

export type AgentIconKey =
  | "portfolio"
  | "xp"
  | "flame"
  | "holderTier"
  | "gauge"
  | "premium"
  | "rewards"
  | "staking"
  | "lock"
  | "season"
  | "profile"
  | "leaderboard"
  | "suggestion";

export interface AgentAction {
  id: string;
  label: string;
  description: string;
  href: string;
  icon: AgentIconKey;
  variant: "primary" | "secondary";
}

export interface AgentHighlight {
  id: string;
  label: string;
  icon: AgentIconKey;
}

// --- Smart Action Cards ---------------------------------------------------
// Each builder checks its own context slice for null (same defensive style
// as lib/agent-intelligence.ts's reply handlers) and returns [] rather than
// guessing a destination when the underlying data isn't available.

function actionsPortfolioSummary(ctx: AgentContext): AgentAction[] {
  if (!ctx.portfolio) return [];
  const actions: AgentAction[] = [
    {
      id: "portfolio-profile",
      label: "View Full Profile",
      description: "XP, Holder Tier, Premium & Season Pass in one place",
      href: "/profile",
      icon: "profile",
      variant: "primary",
    },
  ];
  if (ctx.portfolio.claimableRewards > 0) {
    actions.push({
      id: "portfolio-rewards",
      label: "Claim Rewards",
      description: `${formatCompactNumber(ctx.portfolio.claimableRewards)} MPGR ready to claim`,
      href: "/rewards",
      icon: "rewards",
      variant: "secondary",
    });
  }
  actions.push({
    id: "portfolio-staking",
    label: "Open Staking",
    description: "Stake more MPGR to start earning rewards",
    href: "/staking",
    icon: "staking",
    variant: "secondary",
  });
  return actions;
}

function actionsXPStatus(ctx: AgentContext): AgentAction[] {
  if (!ctx.xp) return [];
  return [
    {
      id: "xp-profile",
      label: "View Profile",
      description: "See your full XP breakdown and daily streak",
      href: "/profile",
      icon: "profile",
      variant: "primary",
    },
    {
      id: "xp-leaderboard",
      label: "Check Leaderboard",
      description: "See how your XP ranks community-wide",
      href: "/leaderboard",
      icon: "leaderboard",
      variant: "secondary",
    },
  ];
}

function actionsHolderTier(ctx: AgentContext): AgentAction[] {
  if (!ctx.holderTier) return [];
  return [
    {
      id: "tier-profile",
      label: "View Holder Tier",
      description: "See your full tier breakdown and benefits",
      href: "/profile",
      icon: "holderTier",
      variant: "primary",
    },
  ];
}

function actionsPremiumStatus(ctx: AgentContext): AgentAction[] {
  if (!ctx.premium) return [];
  const actions: AgentAction[] = ctx.premium.isPremium
    ? [
        {
          id: "premium-profile",
          label: "View Premium Status",
          description: "See your tier, multipliers and perks",
          href: "/profile",
          icon: "premium",
          variant: "primary",
        },
      ]
    : [
        {
          id: "premium-lock",
          label: "Lock MPGR for Premium",
          description: "Unlock a Premium tier and boost your multipliers",
          href: "/app/token-lock",
          icon: "lock",
          variant: "primary",
        },
      ];
  actions.push({
    id: "premium-compare",
    label: "Compare Premium Tiers",
    description: "See every tier and what it unlocks",
    href: "/premium",
    icon: "premium",
    variant: "secondary",
  });
  return actions;
}

function actionsClaimableRewards(ctx: AgentContext): AgentAction[] {
  if (!ctx.rewards) return [];
  const actions: AgentAction[] = [
    {
      id: "rewards-open",
      label: "Open Rewards",
      description: "Claim your MPGR rewards now",
      href: "/rewards",
      icon: "rewards",
      variant: "primary",
    },
  ];
  if (ctx.staking && ctx.staking.claimableRewards > 0) {
    actions.push({
      id: "rewards-staking",
      label: "Claim Staking Rewards",
      description: "Separate staking rewards also ready to claim",
      href: "/staking",
      icon: "staking",
      variant: "secondary",
    });
  }
  return actions;
}

function actionsStakingSummary(ctx: AgentContext): AgentAction[] {
  if (!ctx.staking) return [];
  return [
    ctx.staking.activePositionsCount === 0
      ? {
          id: "staking-start",
          label: "Start Staking",
          description: "Stake MPGR and start earning rewards",
          href: "/staking",
          icon: "staking" as const,
          variant: "primary" as const,
        }
      : {
          id: "staking-open",
          label: "Open Staking",
          description: "Manage your active staking positions",
          href: "/staking",
          icon: "staking" as const,
          variant: "primary" as const,
        },
  ];
}

function actionsLockedTokens(ctx: AgentContext): AgentAction[] {
  if (!ctx.tokenLock) return [];
  return [
    ctx.tokenLock.activeLocksCount === 0
      ? {
          id: "lock-create",
          label: "Create a Lock",
          description: "Lock MPGR to boost Premium and Holder Score",
          href: "/app/token-lock",
          icon: "lock" as const,
          variant: "primary" as const,
        }
      : {
          id: "lock-open",
          label: "Open Token Lock",
          description: "Manage your active locks",
          href: "/app/token-lock",
          icon: "lock" as const,
          variant: "primary" as const,
        },
  ];
}

function actionsSeasonProgress(ctx: AgentContext): AgentAction[] {
  if (!ctx.season) return [];
  return [
    {
      id: "season-open",
      label: "Open Season Pass",
      description: "Track missions and claim season rewards",
      href: "/season-pass",
      icon: "season",
      variant: "primary",
    },
  ];
}

function actionsReferralOverview(ctx: AgentContext): AgentAction[] {
  if (!ctx.xp) return [];
  return [
    {
      id: "referral-profile",
      label: "Get Referral Link",
      description: "Share your link from your Profile page",
      href: "/profile",
      icon: "profile",
      variant: "primary",
    },
  ];
}

// Phase 3D — "Compare Premium Tiers" as its own intent (distinct from
// premium_status, which reports the user's CURRENT tier). Always offers
// the /premium comparison page as the primary action, since that's the
// one page in the app that actually renders every tier side-by-side
// (components/features/premium/PremiumTierTable.tsx).
function actionsComparePremium(ctx: AgentContext): AgentAction[] {
  const actions: AgentAction[] = [
    {
      id: "compare-premium-open",
      label: "Open Premium Tiers",
      description: "See every tier, requirement, and multiplier",
      href: "/premium",
      icon: "premium",
      variant: "primary",
    },
  ];
  if (ctx.premium && !ctx.premium.isPremium) {
    actions.push({
      id: "compare-premium-lock",
      label: "Lock MPGR for Premium",
      description: "Start climbing toward Silver, the first tier",
      href: "/app/token-lock",
      icon: "lock",
      variant: "secondary",
    });
  }
  return actions;
}

// Phase 3D — "Suggest Best Next Action". A small, deterministic
// recommendation checklist over AgentContext, ordered by what's most
// immediately valuable to the user right now (money already earned and
// waiting > underused features > general exploration). Each rule reuses
// exactly the same context fields (and, for the claim/staking/lock
// actions, the exact SAME AgentAction shape) the intent-specific builders
// above already produce — no second definition of "what does claiming
// rewards look like" exists anywhere in this file.
function actionsSuggestNextAction(ctx: AgentContext): AgentAction[] {
  const suggestions: AgentAction[] = [];

  if (ctx.rewards && ctx.rewards.claimableTotal > 0) {
    suggestions.push({
      id: "suggest-claim-rewards",
      label: "Claim Rewards",
      description: `${formatCompactNumber(ctx.rewards.claimableTotal)} MPGR ready to claim right now`,
      href: "/rewards",
      icon: "rewards",
      variant: "primary",
    });
  }

  if (ctx.staking && ctx.staking.claimableRewards > 0) {
    suggestions.push({
      id: "suggest-claim-staking",
      label: "Claim Staking Rewards",
      description: `${formatCompactNumber(ctx.staking.claimableRewards)} MPGR staking rewards ready`,
      href: "/staking",
      icon: "staking",
      variant: suggestions.length === 0 ? "primary" : "secondary",
    });
  }

  if (ctx.staking && ctx.staking.activePositionsCount === 0) {
    suggestions.push({
      id: "suggest-start-staking",
      label: "Start Staking",
      description: "You aren't staking yet — put idle MPGR to work",
      href: "/staking",
      icon: "staking",
      variant: suggestions.length === 0 ? "primary" : "secondary",
    });
  }

  if (ctx.premium && !ctx.premium.isPremium) {
    suggestions.push({
      id: "suggest-unlock-premium",
      label: "Unlock Premium",
      description: "Lock MPGR to boost your XP and Rewards multipliers",
      href: "/app/token-lock",
      icon: "lock",
      variant: suggestions.length === 0 ? "primary" : "secondary",
    });
  }

  if (ctx.holderTier && ctx.holderTier.nextTierLabel) {
    suggestions.push({
      id: "suggest-holder-tier",
      label: "Grow Your Holder Tier",
      description: `${formatCompactNumber(ctx.holderTier.amountToNextTier)} MPGR from ${ctx.holderTier.nextTierLabel}`,
      href: "/profile",
      icon: "holderTier",
      variant: suggestions.length === 0 ? "primary" : "secondary",
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      id: "suggest-profile",
      label: "View Full Profile",
      description: "You're in great shape — check your full standing",
      href: "/profile",
      icon: "profile",
      variant: "primary",
    });
  }

  return suggestions.slice(0, 3);
}

const ACTION_BUILDERS: Record<AgentIntent, (ctx: AgentContext) => AgentAction[]> = {
  portfolio_summary: actionsPortfolioSummary,
  xp_status: actionsXPStatus,
  holder_tier: actionsHolderTier,
  premium_status: actionsPremiumStatus,
  claimable_rewards: actionsClaimableRewards,
  staking_summary: actionsStakingSummary,
  locked_tokens: actionsLockedTokens,
  season_progress: actionsSeasonProgress,
  referral_overview: actionsReferralOverview,
  compare_premium: actionsComparePremium,
  suggest_next_action: actionsSuggestNextAction,
  general_help: () => [],
};

export function getAgentActions(intent: AgentIntent, ctx: AgentContext): AgentAction[] {
  return ACTION_BUILDERS[intent](ctx);
}

// --- Highlight Chips -------------------------------------------------------
// Compact key-stat callouts rendered above an assistant reply's text. Same
// defensive-null rule as above: no chip is shown for data that isn't loaded
// or a milestone that hasn't been reached yet (e.g. no Holder Tier chip
// until the user actually has a tier).

function highlightsPortfolioSummary(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.portfolio) return [];
  const highlights: AgentHighlight[] = [
    { id: "h-total", label: `${formatCompactNumber(ctx.portfolio.totalHoldings)} MPGR Total`, icon: "portfolio" },
  ];
  if (ctx.portfolio.claimableRewards > 0) {
    highlights.push({
      id: "h-claimable",
      label: `${formatCompactNumber(ctx.portfolio.claimableRewards)} Claimable`,
      icon: "rewards",
    });
  }
  return highlights;
}

function highlightsXPStatus(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.xp) return [];
  return [
    { id: "h-level", label: `Level ${ctx.xp.level}`, icon: "xp" },
    { id: "h-streak", label: `${ctx.xp.streak}-Day Streak`, icon: "flame" },
  ];
}

function highlightsHolderTier(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.holderTier || !ctx.holderTier.tierLabel) return [];
  return [
    { id: "h-tier", label: `${ctx.holderTier.tierLabel} Tier`, icon: "holderTier" },
    { id: "h-voting", label: `${formatCompactNumber(ctx.holderTier.votingWeight)} Voting Weight`, icon: "gauge" },
  ];
}

function highlightsPremiumStatus(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.premium || !ctx.premium.isPremium) return [];
  return [
    { id: "h-premium-tier", label: `${ctx.premium.tierLabel} Tier`, icon: "premium" },
    { id: "h-premium-xp", label: `${ctx.premium.xpMultiplier}× XP`, icon: "xp" },
  ];
}

function highlightsClaimableRewards(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.rewards || ctx.rewards.claimableTotal <= 0) return [];
  return [{ id: "h-claimable", label: `${formatCompactNumber(ctx.rewards.claimableTotal)} Claimable`, icon: "rewards" }];
}

function highlightsStakingSummary(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.staking || ctx.staking.activePositionsCount === 0) return [];
  return [
    { id: "h-staked", label: `${formatCompactNumber(ctx.staking.totalStaked)} Staked`, icon: "staking" },
    {
      id: "h-positions",
      label: `${ctx.staking.activePositionsCount} Position${ctx.staking.activePositionsCount === 1 ? "" : "s"}`,
      icon: "gauge",
    },
  ];
}

function highlightsLockedTokens(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.tokenLock || ctx.tokenLock.activeLocksCount === 0) return [];
  return [{ id: "h-locked", label: `${formatCompactNumber(ctx.tokenLock.totalLocked)} Locked`, icon: "lock" }];
}

function highlightsSeasonProgress(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.season) return [];
  return [
    { id: "h-season", label: `Season ${ctx.season.seasonNumber}`, icon: "season" },
    { id: "h-season-level", label: `Level ${ctx.season.level}`, icon: "xp" },
  ];
}

function highlightsReferralOverview(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.xp || ctx.xp.referralCount === 0) return [];
  return [{ id: "h-referrals", label: `${ctx.xp.referralCount} Referral${ctx.xp.referralCount === 1 ? "" : "s"}`, icon: "profile" }];
}

function highlightsComparePremium(ctx: AgentContext): AgentHighlight[] {
  if (!ctx.premium) return [];
  return ctx.premium.isPremium
    ? [{ id: "h-compare-current", label: `Currently ${ctx.premium.tierLabel}`, icon: "premium" }]
    : [];
}

function highlightsSuggestNextAction(ctx: AgentContext): AgentHighlight[] {
  const top = actionsSuggestNextAction(ctx)[0];
  return top ? [{ id: "h-suggest-top", label: top.label, icon: "suggestion" }] : [];
}

const HIGHLIGHT_BUILDERS: Record<AgentIntent, (ctx: AgentContext) => AgentHighlight[]> = {
  portfolio_summary: highlightsPortfolioSummary,
  xp_status: highlightsXPStatus,
  holder_tier: highlightsHolderTier,
  premium_status: highlightsPremiumStatus,
  claimable_rewards: highlightsClaimableRewards,
  staking_summary: highlightsStakingSummary,
  locked_tokens: highlightsLockedTokens,
  season_progress: highlightsSeasonProgress,
  referral_overview: highlightsReferralOverview,
  compare_premium: highlightsComparePremium,
  suggest_next_action: highlightsSuggestNextAction,
  general_help: () => [],
};

export function getAgentHighlights(intent: AgentIntent, ctx: AgentContext): AgentHighlight[] {
  return HIGHLIGHT_BUILDERS[intent](ctx);
}

// --- Follow-up prompts ------------------------------------------------------
// Deliberately phrased to contain the exact substrings
// lib/agent-intelligence.ts's INTENT_PATTERNS already matches on, so
// tapping one routes correctly with zero changes to detection logic.

const FOLLOW_UP_PROMPTS: Record<AgentIntent, string[]> = {
  portfolio_summary: ["What's my Holder Tier?", "Any rewards to claim?"],
  xp_status: ["What's my Holder Tier?", "Show my portfolio summary"],
  holder_tier: ["Show my portfolio summary", "What's my Premium status?"],
  premium_status: ["What's my Holder Tier?", "Any rewards to claim?"],
  claimable_rewards: ["Show my staking summary", "Show my portfolio summary"],
  staking_summary: ["Any rewards to claim?", "Show my portfolio summary"],
  locked_tokens: ["What's my Premium status?", "Show my portfolio summary"],
  season_progress: ["How much XP do I have?", "What's my Holder Tier?"],
  referral_overview: ["How much XP do I have?", "Show my portfolio summary"],
  compare_premium: ["What's my Premium status?", "What should I do next?"],
  suggest_next_action: ["Show my portfolio summary", "What's my Holder Tier?"],
  general_help: ["Show my portfolio summary", "How much XP do I have?", "What should I do next?"],
};

export function getFollowUpPrompts(intent: AgentIntent): string[] {
  return FOLLOW_UP_PROMPTS[intent] ?? [];
}

// --- Smart Response Cards (Phase 3D) ---------------------------------------
// A single generic card shape (title + compact stat list + optional
// progress bar + optional nested actions) covers all nine card types the
// spec calls out, rather than nine bespoke payload shapes — every field
// is plain, JSON-serializable data (same "no component reference" rule
// as AgentAction/AgentHighlight above), rendered by exactly one component
// (components/features/agent/AgentSmartCard.tsx) that reuses the app's
// existing GlassCard/ProgressBar/AgentActionCard primitives instead of
// duplicating their layout logic.

export type SmartCardType =
  | "xp_summary"
  | "season_summary"
  | "holder_tier"
  | "premium_status"
  | "rewards_summary"
  | "portfolio_snapshot"
  | "staking_summary"
  | "lock_summary"
  | "action_suggestions";

export interface SmartCardStat {
  label: string;
  value: string;
}

export interface SmartCardPayload {
  id: string;
  type: SmartCardType;
  title: string;
  subtitle?: string;
  icon: AgentIconKey;
  stats: SmartCardStat[];
  progress?: { label: string; percent: number } | null;
  actions?: AgentAction[];
}

function cardXPSummary(ctx: AgentContext): SmartCardPayload | null {
  if (!ctx.xp) return null;
  return {
    id: "card-xp",
    type: "xp_summary",
    title: "XP Summary",
    subtitle: `Level ${ctx.xp.level}`,
    icon: "xp",
    stats: [
      { label: "Total XP", value: formatCompactNumber(ctx.xp.xp) },
      { label: "Streak", value: `${ctx.xp.streak} day${ctx.xp.streak === 1 ? "" : "s"}` },
      { label: "Referrals", value: `${ctx.xp.referralCount}` },
    ],
    progress: { label: `Toward Level ${ctx.xp.nextLevel}`, percent: ctx.xp.progress },
  };
}

function cardSeasonSummary(ctx: AgentContext): SmartCardPayload | null {
  if (!ctx.season) return null;
  return {
    id: "card-season",
    type: "season_summary",
    title: `Season ${ctx.season.seasonNumber}`,
    subtitle: `Level ${ctx.season.level}`,
    icon: "season",
    stats: [{ label: "Season Points", value: formatCompactNumber(ctx.season.seasonPoints) }],
    progress: { label: "Level Progress", percent: ctx.season.progress },
  };
}

function cardHolderTier(ctx: AgentContext): SmartCardPayload | null {
  if (!ctx.holderTier || !ctx.holderTier.tierLabel) return null;
  return {
    id: "card-holder-tier",
    type: "holder_tier",
    title: `${ctx.holderTier.tierLabel} Holder Tier`,
    subtitle: ctx.holderTier.nextTierLabel ? `Next: ${ctx.holderTier.nextTierLabel}` : "Top tier reached",
    icon: "holderTier",
    stats: [
      { label: "Holder Score", value: formatCompactNumber(ctx.holderTier.totalScore) },
      { label: "Voting Weight", value: formatCompactNumber(ctx.holderTier.votingWeight) },
      { label: "Reputation", value: formatCompactNumber(ctx.holderTier.reputationScore) },
    ],
    progress: ctx.holderTier.nextTierLabel
      ? { label: `Toward ${ctx.holderTier.nextTierLabel}`, percent: Math.round(ctx.holderTier.progressToNextTier * 100) }
      : null,
  };
}

function cardPremiumStatus(ctx: AgentContext): SmartCardPayload | null {
  if (!ctx.premium) return null;
  return {
    id: "card-premium",
    type: "premium_status",
    title: ctx.premium.isPremium ? `${ctx.premium.tierLabel} Premium` : "Not Premium Yet",
    subtitle: ctx.premium.nextTierLabel ? `Next: ${ctx.premium.nextTierLabel}` : undefined,
    icon: "premium",
    stats: [
      { label: "XP Multiplier", value: `${ctx.premium.xpMultiplier}×` },
      { label: "Rewards Multiplier", value: `${ctx.premium.rewardsMultiplier}×` },
    ],
    progress: ctx.premium.nextTierLabel
      ? { label: `Toward ${ctx.premium.nextTierLabel}`, percent: Math.round(ctx.premium.progressToNextTier * 100) }
      : null,
  };
}

function cardRewardsSummary(ctx: AgentContext): SmartCardPayload | null {
  if (!ctx.rewards) return null;
  return {
    id: "card-rewards",
    type: "rewards_summary",
    title: "Rewards Summary",
    icon: "rewards",
    stats: [
      { label: "Claimable Now", value: `${formatCompactNumber(ctx.rewards.claimableTotal)} MPGR` },
      { label: "Claimed Lifetime", value: `${formatCompactNumber(ctx.rewards.totalClaimed)} MPGR` },
    ],
  };
}

function cardPortfolioSnapshot(ctx: AgentContext): SmartCardPayload | null {
  if (!ctx.portfolio) return null;
  return {
    id: "card-portfolio",
    type: "portfolio_snapshot",
    title: "Portfolio Snapshot",
    icon: "portfolio",
    stats: [
      { label: "Wallet", value: formatCompactNumber(ctx.portfolio.walletBalance) },
      { label: "Staked", value: formatCompactNumber(ctx.portfolio.stakedBalance) },
      { label: "Locked", value: formatCompactNumber(ctx.portfolio.lockedBalance) },
      { label: "Total", value: formatCompactNumber(ctx.portfolio.totalHoldings) },
    ],
  };
}

function cardStakingSummary(ctx: AgentContext): SmartCardPayload | null {
  if (!ctx.staking) return null;
  return {
    id: "card-staking",
    type: "staking_summary",
    title: "Staking Summary",
    subtitle: `${ctx.staking.activePositionsCount} active position${ctx.staking.activePositionsCount === 1 ? "" : "s"}`,
    icon: "staking",
    stats: [
      { label: "Total Staked", value: formatCompactNumber(ctx.staking.totalStaked) },
      { label: "Claimable", value: formatCompactNumber(ctx.staking.claimableRewards) },
    ],
  };
}

function cardLockSummary(ctx: AgentContext): SmartCardPayload | null {
  if (!ctx.tokenLock) return null;
  return {
    id: "card-lock",
    type: "lock_summary",
    title: "Lock Summary",
    subtitle: `${ctx.tokenLock.activeLocksCount} active lock${ctx.tokenLock.activeLocksCount === 1 ? "" : "s"}`,
    icon: "lock",
    stats: [{ label: "Total Locked", value: formatCompactNumber(ctx.tokenLock.totalLocked) }],
  };
}

function cardActionSuggestions(ctx: AgentContext): SmartCardPayload | null {
  const suggestions = actionsSuggestNextAction(ctx);
  if (suggestions.length === 0) return null;
  return {
    id: "card-suggestions",
    type: "action_suggestions",
    title: "Suggested Next Actions",
    icon: "suggestion",
    stats: [],
    actions: suggestions,
  };
}

const CARD_BUILDERS: Partial<Record<AgentIntent, (ctx: AgentContext) => SmartCardPayload | null>> = {
  xp_status: cardXPSummary,
  season_progress: cardSeasonSummary,
  holder_tier: cardHolderTier,
  premium_status: cardPremiumStatus,
  compare_premium: cardPremiumStatus,
  claimable_rewards: cardRewardsSummary,
  portfolio_summary: cardPortfolioSnapshot,
  staking_summary: cardStakingSummary,
  locked_tokens: cardLockSummary,
  suggest_next_action: cardActionSuggestions,
};

// Builds a Smart Response Card for intents that have one — several
// intents (general_help, referral_overview) intentionally have none, in
// which case this returns null and the assistant reply stays plain
// text + action cards, exactly as before Phase 3D.
export function getSmartCard(intent: AgentIntent, ctx: AgentContext): SmartCardPayload | null {
  const builder = CARD_BUILDERS[intent];
  return builder ? builder(ctx) : null;
}

// --- Structured Action Payloads (Phase 3D) ---------------------------------
// The `{ intent, action, target }` shape the product spec's own examples
// show. Built from data this file already computed above (getSmartCard /
// getAgentActions) — never a second calculation.

export type SmartActionKind = "navigate" | "display_card" | "quick_action" | "confirm";

export interface SmartActionPayload {
  intent: AgentIntent;
  action: SmartActionKind;
  target?: string;
  card?: SmartCardPayload;
}

export function buildSmartActionPayload(intent: AgentIntent, ctx: AgentContext): SmartActionPayload {
  const card = getSmartCard(intent, ctx);
  if (card) {
    return { intent, action: "display_card", target: undefined, card };
  }

  const actions = getAgentActions(intent, ctx);
  const primary = actions.find((a) => a.variant === "primary") ?? actions[0];
  if (primary) {
    return { intent, action: "navigate", target: primary.href };
  }

  return { intent, action: "quick_action" };
}

// Re-exported so lib/agent-intelligence.ts's compare_premium reply text
// can read tier/multiplier constants without a second, separate import
// path to lib/premium-config.ts.
export { PREMIUM_TIERS, PREMIUM_REWARDS_MULTIPLIER, PREMIUM_XP_MULTIPLIER };
