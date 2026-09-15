"use client";

import Link from "next/link";
import { BarChart3, Briefcase, Gift, Repeat } from "lucide-react";

const ACTIONS = [
  {
    id: "research",
    label: "Research",
    hint: "Market insights",
    icon: BarChart3,
    prompt: "What's moving in the market today?",
  },
  {
    id: "trade",
    label: "Trade",
    hint: "Buy & sell",
    icon: Repeat,
    prompt: "Help me plan a tokenized stock trade on Base.",
  },
  {
    id: "portfolio",
    label: "Portfolio",
    hint: "Your holdings",
    icon: Briefcase,
    prompt: "Analyze my MPGR HUB portfolio and tell me what stands out.",
  },
] as const;

interface AgentQuickActionsProps {
  onSelectPrompt: (prompt: string) => void;
  disabled?: boolean;
}

export function AgentQuickActions({ onSelectPrompt, disabled }: AgentQuickActionsProps) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {ACTIONS.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelectPrompt(action.prompt)}
            className="flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-2xl border border-white/[0.07] bg-surface px-1.5 py-2.5 text-center transition-colors hover:border-primary/25 hover:bg-surface-2 disabled:opacity-50"
          >
            <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
            <span className="text-[11px] font-semibold text-white">{action.label}</span>
            <span className="hidden text-[10px] text-muted sm:block">{action.hint}</span>
          </button>
        );
      })}
      <Link
        href="/rewards"
        className="flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-2xl border border-white/[0.07] bg-surface px-1.5 py-2.5 text-center transition-colors hover:border-primary/25 hover:bg-surface-2"
      >
        <Gift className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="text-[11px] font-semibold text-white">Rewards</span>
        <span className="hidden text-[10px] text-muted sm:block">Progress & perks</span>
      </Link>
    </div>
  );
}
