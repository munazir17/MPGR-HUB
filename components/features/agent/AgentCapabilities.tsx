"use client";

import { ChevronRight } from "lucide-react";
import { AGENT_RESEARCH_PROMPTS, AGENT_ONCHAIN_PROMPTS } from "@/lib/agent-config";

interface AgentCapabilitiesProps {
  onSelectPrompt: (prompt: string) => void;
  connected: boolean;
  onNeedWallet?: () => void;
}

export function AgentCapabilities({
  onSelectPrompt,
  connected,
  onNeedWallet,
}: AgentCapabilitiesProps) {
  const handle = (prompt: string, onchain: boolean) => {
    if (onchain && !connected) {
      onNeedWallet?.();
      return;
    }
    if (!connected) {
      onNeedWallet?.();
      return;
    }
    onSelectPrompt(prompt);
  };

  return (
    <section className="mt-4 rounded-2xl border border-white/[0.08] bg-surface px-4 py-4">
      <h2 className="text-sm font-semibold text-white">What can MPGR Agent do?</h2>
      <p className="mt-1 text-xs leading-5 text-muted">
        Explore first. Connect a wallet when an onchain action needs confirmation.
        The Agent prepares; you sign.
      </p>

      <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.14em] text-primary">
        Read / research
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {AGENT_RESEARCH_PROMPTS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => handle(item.prompt, false)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/[0.08] bg-background px-3 py-1.5 text-xs text-white/90 transition-colors hover:border-primary/35 hover:bg-surface-2 active:scale-[0.98]"
          >
            {item.label}
            <ChevronRight className="h-3 w-3 text-primary" aria-hidden />
          </button>
        ))}
      </div>

      <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.14em] text-gold">
        Onchain — wallet + confirm
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {AGENT_ONCHAIN_PROMPTS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => handle(item.prompt, true)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-gold/20 bg-background px-3 py-1.5 text-xs text-white/90 transition-colors hover:border-gold/45 hover:bg-surface-2 active:scale-[0.98]"
          >
            {item.label}
            <ChevronRight className="h-3 w-3 text-gold" aria-hidden />
          </button>
        ))}
      </div>
    </section>
  );
}
