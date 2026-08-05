import type { AgentIntent } from "@/lib/agent-intelligence";
import type { AgentContext } from "@/lib/agent-context";
import { formatCompactNumber } from "@/lib/format";

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
// import lucide-react components into this file.
//
// Routes below were verified against the actual app/ tree, not assumed:
// Season Pass status here comes from useSeasonPass (season_progress
// intent), which is the /season-pass page's data source — NOT /season,
// which is a separate, XP-engine-driven season-points page. Token Lock
// lives at /app/token-lock (matches components/Navbar.tsx's own link).

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
  | "leaderboard";

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
  general_help: ["Show my portfolio summary", "How much XP do I have?", "What's my Holder Tier?"],
};

export function getFollowUpPrompts(intent: AgentIntent): string[] {
  return FOLLOW_UP_PROMPTS[intent] ?? [];
}
