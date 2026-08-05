import { formatCompactNumber } from "@/lib/format";
import type { AgentContext } from "@/lib/agent-context";
import {
  getAgentActions,
  getAgentHighlights,
  getFollowUpPrompts,
  getSmartCard,
  buildSmartActionPayload,
  PREMIUM_TIERS,
  PREMIUM_XP_MULTIPLIER,
  PREMIUM_REWARDS_MULTIPLIER,
  type AgentAction,
  type AgentHighlight,
  type SmartCardPayload,
  type SmartActionPayload,
} from "@/lib/agent-actions";
// Phase 3B Part 2 — Conversation Intelligence. Type-only import: no
// runtime dependency is introduced here (memory-context.ts's only
// runtime imports are from the memory layer + action-history.ts), so
// this stays exactly what it was before — a deterministic, local,
// no-network reasoning layer. See generateIntelligentReply's doc comment
// below for how memoryContext is used.
import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";

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
// component) only ever sees `{ intent, reply, actions, highlights,
// followUps }`, so that swap won't require touching anything outside this
// file plus its call site in lib/agent-engine.ts.
//
// Phase 3A.3 — Smart Actions & Conversational UX: `actions`, `highlights`,
// and `followUps` are new fields on the result, all derived in
// lib/agent-actions.ts from the exact same AgentContext the text reply
// already reads from. No new data source, no new hook — this is presentation
// on top of state that was already being computed.
//
// "XP Status" and "Level Progress" are intentionally the SAME intent here
// (`xp_status`) rather than two — level is directly derived from XP via
// getLevelProgress(xp) in lib/xp-engine.ts, so there is no second data
// source that would justify a separate branch. This also matches the
// product spec's own example, where "How much XP?", "What level am I?",
// "My XP", and "Show progress" are all expected to resolve to one intent.
//
// Phase 3B Part 2 — Conversation Intelligence. detectIntent() and
// generateIntelligentReply() both take an optional ConversationMemoryContext
// (built by lib/architecture/memory/memory-context.ts and passed in by
// lib/agent-engine.ts). It's optional and every existing call path that
// omits it behaves byte-for-byte the same as before — this is additive
// personalization/continuity on top of the exact same deterministic
// pattern matching, not a replacement for it.
//
// Bug fix (post Phase 3C audit) — isFollowUp() previously treated ANY
// message of 3 words or fewer as a follow-up to the previous topic,
// regardless of what it actually said. This meant short, standalone
// questions like "Who are you?" would silently inherit whatever intent
// was last discussed (e.g. rewards/staking) instead of getting their own
// answer. Fixed below: a message is now only a follow-up if it actually
// matches one of FOLLOW_UP_PATTERNS ("what about...", "and...", "also...",
// "what else...", "how about..."). Every other branch of detectIntent is
// unchanged.
//
// Phase 3D — Smart Actions & AI Automation. Two additions, additive only:
//   1. Two new intents — compare_premium ("Compare Premium Tiers") and
//      suggest_next_action ("Suggest Best Next Action") — registered into
//      every Record<AgentIntent, ...> below exactly like every existing
//      intent already is.
//   2. AgentIntelligenceResult gains `card` and `smartAction`, computed at
//      the very end of generateIntelligentReply() from
//      lib/agent-actions.ts's getSmartCard()/buildSmartActionPayload() —
//      both pure reshapes of data this file already has in hand (intent +
//      AgentContext), never a second calculation.

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
  | "compare_premium"
  | "suggest_next_action"
  | "general_help";

// Phase 3C Part 4 — a canonical runtime array mirroring AgentIntent's
// union members, one-to-one. TypeScript unions have no runtime
// representation, so anything that needs to validate an untrusted value
// (e.g. lib/architecture/ai/ai-provider-guardrails.ts, checking a real
// model's output) needs an actual array to check membership against.
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
  "compare_premium",
  "suggest_next_action",
  "general_help",
];

export interface AgentIntelligenceResult {
  intent: AgentIntent;
  reply: string;
  actions: AgentAction[];
  highlights: AgentHighlight[];
  followUps: string[];
  // Phase 3D — additive. Both are omitted (undefined) on the
  // not-connected and greeting early-return branches below, exactly like
  // actions/highlights are already []-but-present there; every existing
  // caller that doesn't read these two fields is unaffected.
  card?: SmartCardPayload | null;
  smartAction?: SmartActionPayload;
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
  compare_premium: [
    "compare premium",
    "premium tiers",
    "premium tier comparison",
    "which premium tier",
    "compare tiers",
    "difference between premium tiers",
  ],
  suggest_next_action: [
    "what should i do next",
    "suggest next action",
    "best next action",
    "what should i do",
    "recommend something",
    "any suggestions",
    "what's my next move",
  ],
  general_help: ["help", "what can you do", "what do you do"],
};

// Fixed iteration order used as the tie-break when two intents score
// equally — first match in this list wins.
const INTENT_PRIORITY: AgentIntent[] = [
  "portfolio_summary",
  "holder_tier",
  "compare_premium",
  "premium_status",
  "season_progress",
  "staking_summary",
  "locked_tokens",
  "claimable_rewards",
  "xp_status",
  "referral_overview",
  "suggest_next_action",
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

// Bug fix — the old implementation also returned true for ANY message of
// 3 words or fewer ("|| wordCount <= 3"), regardless of content. That
// swallowed short, standalone questions like "Who are you?" into
// whatever the previous topic happened to be. Now this only returns true
// when the message actually matches one of FOLLOW_UP_PATTERNS.
function isFollowUp(normalized: string): boolean {
  return FOLLOW_UP_PATTERNS.some((re) => re.test(normalized));
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

// Phase 3B Part 2 — third param is optional and only ever changes the
// FINAL fallback branch (previously always "general_help" when nothing
// else matched). Every other branch — direct pattern match, greeting,
// previousIntent-based follow-up — is byte-for-byte unchanged, so this
// can only ever produce a MORE specific answer than before, never a
// different one where the old logic already had a confident match.
export function detectIntent(
  rawPrompt: string,
  previousIntent: AgentIntent | null,
  memoryContext?: ConversationMemoryContext
): DetectedIntent {
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

  // Phase 3B Part 2 — memory-informed fallback. Only reached when there
  // was no keyword match at all AND no immediate previous-message
  // follow-up — i.e. a case that previously always fell through to the
  // generic general_help reply. If ranked recent history (across the
  // whole conversation, not just the last message) points strongly at
  // one topic, use that instead of a blind generic answer.
  if (memoryContext && memoryContext.dominantRecentIntent) {
    return { intent: memoryContext.dominantRecentIntent, greeting: false };
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
  "I can help with: Portfolio Summary, XP & Level Progress, Holder Tier, Premium Status, Compare Premium Tiers, Claimable Rewards, Staking Summary, Locked Tokens, Season Progress, Referral Overview, and Suggest Best Next Action. Just ask — for example, \"What's my Holder Tier?\", \"Compare Premium tiers\", or \"What should I do next?\"";

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

// Phase 3D — "Compare Premium Tiers". Every tier shares the same flat
// multipliers (lib/premium-config.ts's own header explains why — V1 has
// no per-tier multiplier scaling); the only thing that differs between
// tiers is the MPGR required, so that's what this reply actually
// compares.
function replyComparePremiumTiers(ctx: AgentContext): string {
  const tierLines = PREMIUM_TIERS.map((t) => `${t.label} (${formatCompactNumber(t.minLocked)}+ MPGR locked)`).join(
    ", "
  );
  const currentNote = ctx.premium
    ? ctx.premium.isPremium
      ? ` You're currently on the ${ctx.premium.tierLabel} tier.`
      : " You're not on a Premium tier yet."
    : "";
  return `Every Premium tier gives the same ${PREMIUM_XP_MULTIPLIER}× XP and ${PREMIUM_REWARDS_MULTIPLIER}× Rewards multiplier — what changes is how much MPGR you need locked: ${tierLines}.${currentNote}`;
}

// Phase 3D — "Suggest Best Next Action". Reuses
// lib/agent-actions.ts's getAgentActions("suggest_next_action", ctx) —
// the exact same deterministic, priority-ordered checklist the action
// cards and Smart Response Card for this intent already render — so the
// sentence below can never disagree with what's shown underneath it.
function replySuggestNextAction(ctx: AgentContext): string {
  const suggestions = getAgentActions("suggest_next_action", ctx);
  const top = suggestions[0];
  if (!top) return notAvailable("recommendations");
  const rest = suggestions.slice(1).map((a) => a.label);
  const restNote = rest.length > 0 ? ` After that: ${rest.join(", ")}.` : "";
  return `Right now, the best next move is to ${top.label.toLowerCase()} — ${top.description}.${restNote}`;
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
  compare_premium: replyComparePremiumTiers,
  suggest_next_action: replySuggestNextAction,
  general_help: () => GENERAL_HELP_REPLY,
};

// Phase 3B Part 2 — human-readable labels for recall notes / returning-
// user greetings below. Kept as one small lookup rather than scattering
// strings through each branch.
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
  compare_premium: "Premium tier comparisons",
  suggest_next_action: "what to do next",
  general_help: "MPGR HUB",
};

function buildGreetingReply(memoryContext?: ConversationMemoryContext): string {
  if (!memoryContext || !memoryContext.isReturningUser) return GREETING_REPLY;
  const topic = memoryContext.favoriteTopics[0];
  const topicNote = topic ? ` Want to check in on ${INTENT_LABELS[topic]} again, or ask about something else?` : "";
  return `Welcome back! I've got your MPGR HUB context loaded — XP, staking, Holder Tier, and more.${topicNote}`;
}

// Appends a short, memory-grounded note to an otherwise-unchanged handler
// reply. Returns null (no note) far more often than not — this is meant
// to feel occasional and earned, not attached to every single reply.
function buildRecallNote(intent: AgentIntent, memoryContext?: ConversationMemoryContext): string | null {
  if (!memoryContext) return null;

  if (intent === "general_help") {
    const topic = memoryContext.favoriteTopics[0];
    return topic ? `You've mostly been asking about ${INTENT_LABELS[topic]} — happy to dig into that again, or anything else.` : null;
  }

  const delta = memoryContext.walletDelta;
  if (!delta) return null;

  switch (intent) {
    case "xp_status":
      return delta.xpGained !== null && delta.xpGained > 0
        ? `Since we last talked, you've gained ${formatCompactNumber(delta.xpGained)} XP.`
        : null;
    case "portfolio_summary":
      return delta.holdingsChange !== null && delta.holdingsChange !== 0
        ? `Your total holdings are ${delta.holdingsChange > 0 ? "up" : "down"} ${formatCompactNumber(Math.abs(delta.holdingsChange))} MPGR since last time.`
        : null;
    case "holder_tier":
      return delta.tierChanged && delta.currentTierLabel
        ? `You've moved up to ${delta.currentTierLabel} Holder Tier since we last talked — nice progress.`
        : null;
    case "staking_summary":
      return delta.stakedChange !== null && delta.stakedChange !== 0
        ? `Your staked balance is ${delta.stakedChange > 0 ? "up" : "down"} ${formatCompactNumber(Math.abs(delta.stakedChange))} MPGR since last time.`
        : null;
    case "locked_tokens":
      return delta.lockedChange !== null && delta.lockedChange !== 0
        ? `Your locked balance is ${delta.lockedChange > 0 ? "up" : "down"} ${formatCompactNumber(Math.abs(delta.lockedChange))} MPGR since last time.`
        : null;
    case "season_progress":
      return delta.seasonPointsChange !== null && delta.seasonPointsChange > 0
        ? `You've earned ${formatCompactNumber(delta.seasonPointsChange)} more season points since we last talked.`
        : null;
    default:
      return null;
  }
}

// Single entry point. Phase 3B swap point: this function's body becomes an
// async model call; its signature (prompt + context + previousIntent) can
// stay the same since AgentContext already carries everything a model
// would need to ground its answer in real app state. actions/highlights/
// followUps would then come from the model's structured output instead of
// lib/agent-actions.ts's deterministic builders — the result shape stays
// identical either way.
//
// Phase 3B Part 2 — memoryContext is the fourth, optional argument. It
// only ever (a) resolves the fallback branch of detectIntent when nothing
// else matched, and (b) appends an extra sentence onto a reply that would
// otherwise be identical to before. It never changes which handler runs
// for a direct keyword match, and omitting it entirely reproduces the
// exact pre-Phase-3B-Part-2 output.
//
// Phase 3D — the returned result now also carries `card` (a Smart
// Response Card, or null when this intent has none) and `smartAction`
// (the structured `{ intent, action, target }` payload). Both are
// computed here, once, from the SAME `intent`/`context` this function
// already has — never a second AgentContext read, never a second
// intent-detection pass.
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

  if (greeting) {
    const reply = buildGreetingReply(memoryContext);
    return { intent, reply, actions: [], highlights: [], followUps: getFollowUpPrompts(intent) };
  }

  const baseReply = INTENT_HANDLERS[intent](context);
  const recallNote = buildRecallNote(intent, memoryContext);
  const reply = recallNote ? `${baseReply} ${recallNote}` : baseReply;

  return {
    intent,
    reply,
    actions: getAgentActions(intent, context),
    highlights: getAgentHighlights(intent, context),
    followUps: getFollowUpPrompts(intent),
    card: getSmartCard(intent, context),
    smartAction: buildSmartActionPayload(intent, context),
  };
}
