import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";
import type { AgentIntent } from "./types";
import {
  normalizePrompt,
  looksLikeX402InformationalPrompt,
  looksLikeX402PaymentPrompt,
} from "./prompt-parsers";

export const INTENT_PATTERNS: Record<AgentIntent, string[]> = {
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

export const INTENT_PRIORITY: AgentIntent[] = [
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

export const GREETING_PATTERNS = ["hello", "hi", "hey", "hi there", "yo", "sup"];

export function isGreeting(normalized: string): boolean {
  const wordCount = normalized.split(" ").filter(Boolean).length;
  return wordCount <= 3 && GREETING_PATTERNS.some((g) => normalized === g || normalized.startsWith(g + " "));
}

export const FOLLOW_UP_PATTERNS = [/^what about\b/, /^and\b/, /^also\b/, /^what else\b/, /^how about\b/];

export const PRONOUN_REFERENCE_PATTERN = /\b(it|that|those|them)\b/;

export function isFollowUp(normalized: string): boolean {
  if (FOLLOW_UP_PATTERNS.some((re) => re.test(normalized))) return true;
  const words = normalized.split(" ").filter(Boolean);
  // Long standalone questions that happen to contain "it" ("how MPGR HUB fits into it")
  // are not conversational follow-ups.
  if (words.length > 8) return false;
  return words.length <= 6 && PRONOUN_REFERENCE_PATTERN.test(normalized);
}

export function looksLikeStandaloneResearch(normalized: string): boolean {
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

export const RELATED_TOPICS: Partial<Record<AgentIntent, AgentIntent[]>> = {
  staking_summary: ["claimable_rewards"],
  locked_tokens: ["claimable_rewards"],
  premium_status: ["claimable_rewards", "xp_status"],
  season_progress: ["claimable_rewards", "xp_status"],
  holder_tier: ["portfolio_summary"],
};

export function scoreIntents(normalized: string): { intent: AgentIntent; score: number }[] {
  return INTENT_PRIORITY.map((intent) => {
    const patterns = INTENT_PATTERNS[intent];
    const score = patterns.reduce((sum, pattern) => (normalized.includes(pattern) ? sum + 1 : sum), 0);
    return { intent, score };
  });
}

export function bestIntent(normalized: string): AgentIntent | null {
  const scored = scoreIntents(normalized);
  let best: { intent: AgentIntent; score: number } | null = null;
  for (const entry of scored) {
    if (entry.score > 0 && (!best || entry.score > best.score)) {
      best = entry;
    }
  }
  return best ? best.intent : null;
}

export interface DetectedIntent {
  intent: AgentIntent;
  greeting: boolean;
}

export function detectIntent(
  rawPrompt: string,
  previousIntent: AgentIntent | null,
  memoryContext?: ConversationMemoryContext
): DetectedIntent {
  const normalized = normalizePrompt(rawPrompt);

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
