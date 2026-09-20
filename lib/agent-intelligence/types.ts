import type { AgentAction, AgentHighlight } from "@/lib/agent-actions";

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
