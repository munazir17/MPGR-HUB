import type { LucideIcon } from "lucide-react";
import { PieChart, Send, Compass, Search, Gift, TrendingUp } from "lucide-react";

// Phase 3A — MPGR Agent frontend foundation. Everything here is local/mock:
// no OpenAI, Claude, Gemini, or backend calls.
//
// Phase 3A.2 note: reply generation itself moved out of this file. Status
// badge definitions and prompt suggestions (both consumed directly by
// components/features/agent/*) stay here; intent detection + reply
// generation now live in lib/agent-intelligence.ts, reading from
// lib/agent-context.ts's AgentContext instead of matching keywords in
// isolation. See lib/agent-intelligence.ts for the Phase 3B swap point.

export type AgentStatusId = "online" | "thinking" | "beta";

export interface AgentStatusDef {
  id: AgentStatusId;
  label: string;
  dotClass: string;
  textClass: string;
  bgClass: string;
  ringClass: string;
  pulse?: boolean;
}

export const AGENT_STATUS: Record<AgentStatusId, AgentStatusDef> = {
  online: {
    id: "online",
    label: "Online",
    dotClass: "bg-primary",
    textClass: "text-primary-glow",
    bgClass: "bg-primary/10",
    ringClass: "ring-primary/20",
  },
  thinking: {
    id: "thinking",
    label: "Thinking",
    dotClass: "bg-gold",
    textClass: "text-gold",
    bgClass: "bg-gold/10",
    ringClass: "ring-gold/20",
    pulse: true,
  },
  beta: {
    id: "beta",
    label: "Beta",
    dotClass: "bg-primary-glow",
    textClass: "text-primary-glow",
    bgClass: "bg-primary/10",
    ringClass: "ring-primary/20",
  },
};

export interface AgentPromptSuggestion {
  id: string;
  label: string;
  prompt: string;
  icon: LucideIcon;
}

// Capability-focused, action-oriented suggestions. This list intentionally
// does NOT read like an XP/Premium/Holder Tier FAQ — each prompt maps to a
// real tool the Agent can actually reach (see lib/architecture/tools/
// tool-definitions.ts, trade-tool-definitions.ts, transfer-tool-definitions.ts):
// portfolio -> portfolio_analyzer, transfer -> transfer_prepare_send,
// next-steps -> wallet_analyzer/holder tier reasoning, research ->
// token_analyzer/base_research, rewards -> yield_opportunities /
// reward vault, opportunities -> yield_opportunities/market_intelligence.
// Do not add these back to a long FAQ-style list — keep this set small.
export const AGENT_PROMPT_SUGGESTIONS: AgentPromptSuggestion[] = [
  {
    id: "portfolio",
    label: "Analyze my portfolio",
    prompt: "Analyze my MPGR HUB portfolio and tell me what stands out.",
    icon: PieChart,
  },
  {
    id: "transfer",
    label: "Plan a Base transfer",
    prompt: "I want to send a token on Base — walk me through it.",
    icon: Send,
  },
  {
    id: "next-steps",
    label: "What should I do next?",
    prompt: "Based on my current position, what should I do next?",
    icon: Compass,
  },
  {
    id: "research",
    label: "Research $MPGR",
    prompt: "Give me a research briefing on $MPGR.",
    icon: Search,
  },
  {
    id: "rewards",
    label: "Check my rewards",
    prompt: "What rewards do I currently have available to claim?",
    icon: Gift,
  },
  {
    id: "opportunities",
    label: "Explore Base opportunities",
    prompt: "What Base-native opportunities should I be looking at right now?",
    icon: TrendingUp,
  },
];
