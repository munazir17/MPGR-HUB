import type { LucideIcon } from "lucide-react";
import { Coins, Gauge, Crown, PieChart, Award, Flame } from "lucide-react";

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

export const AGENT_PROMPT_SUGGESTIONS: AgentPromptSuggestion[] = [
  {
    id: "xp",
    label: "Check my XP progress",
    prompt: "How is my XP and level progress looking?",
    icon: Flame,
  },
  {
    id: "staking",
    label: "How do I stake MPGR?",
    prompt: "How do I stake MPGR and what are the lock options?",
    icon: Coins,
  },
  {
    id: "holder-tier",
    label: "What's my Holder Tier?",
    prompt: "What is my current Holder Tier and how do I level it up?",
    icon: Gauge,
  },
  {
    id: "premium",
    label: "Explain Premium benefits",
    prompt: "What benefits do I get from MPGR Premium?",
    icon: Crown,
  },
  {
    id: "portfolio",
    label: "Show my portfolio summary",
    prompt: "Give me a summary of my MPGR portfolio.",
    icon: PieChart,
  },
  {
    id: "season-pass",
    label: "Season Pass rewards?",
    prompt: "How do Season Pass rewards and levels work?",
    icon: Award,
  },
];
