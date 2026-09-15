import type { LucideIcon } from "lucide-react";
import { PieChart, Send, Search, Gift, TrendingUp } from "lucide-react";

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
    dotClass: "bg-primary-glow",
    textClass: "text-primary-glow",
    bgClass: "bg-primary/10",
    ringClass: "ring-primary/20",
    pulse: true,
  },
  beta: {
    id: "beta",
    label: "Ready",
    dotClass: "bg-emerald-400",
    textClass: "text-emerald-300",
    bgClass: "bg-emerald-400/10",
    ringClass: "ring-emerald-400/20",
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
    id: "market",
    label: "What's moving in the market?",
    prompt: "What's moving in the market today?",
    icon: TrendingUp,
  },
  {
    id: "portfolio",
    label: "Analyze my portfolio",
    prompt: "Analyze my MPGR HUB portfolio and tell me what stands out.",
    icon: PieChart,
  },
  {
    id: "stocks",
    label: "Find undervalued tokenized stocks",
    prompt: "Find undervalued tokenized stocks I should look at on Base.",
    icon: Search,
  },
  {
    id: "transfer",
    label: "Plan a Base transfer",
    prompt: "I want to send a token on Base — walk me through it.",
    icon: Send,
  },
  {
    id: "rewards",
    label: "Show my rewards",
    prompt: "What rewards do I currently have available to claim?",
    icon: Gift,
  },
];
