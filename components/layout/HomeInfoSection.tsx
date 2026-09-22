"use client";

// components/layout/HomeInfoSection.tsx
//
// The compact MPGR HUB positioning block under the agent chat on Home:
// a short brand message plus exactly THREE medium info cards. It
// replaces what used to be a large empty gap between the chat and the
// footer. Same design system as the rest of the app (GlassCard,
// existing colors/typography) — no new visual theme.

import { Bot, Coins, Network } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { APP_NAME } from "@/lib/site";

const CARDS = [
  {
    icon: Coins,
    title: "Built on Base",
    body: "MPGR HUB is a Base-native platform bringing AI-assisted on-chain interactions, markets, games and community utilities into one experience.",
  },
  {
    icon: Bot,
    title: "MPGR Agent",
    body: "Research, understand and prepare on-chain actions with user confirmation before execution.",
  },
  {
    icon: Network,
    title: "One Base-native ecosystem",
    body: "Explore trading, tokenized assets, games, rewards, staking and the broader MPGR ecosystem.",
  },
] as const;

export function HomeInfoSection() {
  return (
    <section
      aria-label="About MPGR HUB"
      className="mx-auto w-full max-w-6xl px-4 pb-10 pt-6 sm:px-6 md:pt-8 lg:px-8"
      data-testid="home-info-section"
    >
      <div className="text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
          {APP_NAME}
        </p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-white md:text-2xl">
          Build. Explore. Trade. Earn with AI on Base.
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          {APP_NAME} is a Base-native platform combining an AI agent, on-chain
          tools, tokenized asset research, games and community utilities in one
          experience.
        </p>
        <p className="mt-3 text-[11px] font-medium tracking-wide text-muted">
          Built on Base <span className="text-white/25">•</span> Powered by
          on-chain infrastructure <span className="text-white/25">•</span>{" "}
          User-controlled execution
        </p>
      </div>

      <div className="mt-6 grid gap-3 sm:gap-4 md:grid-cols-3">
        {CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <GlassCard key={card.title} className="p-5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-background/60">
                  <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                </span>
                <p className="text-sm font-semibold text-white">{card.title}</p>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted">{card.body}</p>
            </GlassCard>
          );
        })}
      </div>
    </section>
  );
}
