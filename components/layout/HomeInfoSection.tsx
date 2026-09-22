"use client";

// components/layout/HomeInfoSection.tsx
//
// The MPGR HUB product introduction under the agent chat on Home — the
// lower contextual area. It now also carries the agent's supporting
// description (moved out of the hero so the top stays clean): the
// one-line scope + "Agent prepares the transaction. You sign.", and the
// always-visible non-US disclaimer as a quiet footnote.
//
// Three layers, each with a distinct job (no repeated wording):
//   intro  — what MPGR HUB is as a platform;
//   cards  — three specific angles: technical foundation, agent
//            capability, broader ecosystem;
// Same design system as the rest of the app — no new visual theme.

import { Bot, Coins, Network } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { APP_NAME } from "@/lib/site";
import {
  STOCKS_AGENT_DISCLAIMER,
  STOCKS_AGENT_SIGN_LINE,
  STOCKS_AGENT_SUBTITLE,
} from "@/lib/agent-stocks-config";

const CARDS = [
  {
    icon: Coins,
    title: "Built on Base",
    body: "Every core interaction settles on Base mainnet. Balances, swaps, locks and reward accounting are executed as on-chain transactions from your own wallet, against a single typed source of truth for contracts and chain data — with no custodial layer in between.",
  },
  {
    icon: Bot,
    title: "MPGR Agent",
    body: "An AI workspace for on-chain research and action. The agent reasons over live market data, calls read-only tools for pair prices, premiums and contract verification, and prepares swaps and payments that wait for your explicit confirmation before anything moves.",
  },
  {
    icon: Network,
    title: "One Base-native ecosystem",
    body: "Around the agent sits the rest of the hub — tokenized-asset markets, staking and token lock, burn mechanics, seasonal rewards, an arcade led by MPGR Run, and community utilities — all reachable from one menu and one wallet.",
  },
] as const;

export function HomeInfoSection() {
  return (
    <section
      aria-label="About MPGR HUB"
      className="mx-auto w-full px-4 pb-12 pt-10 sm:px-6 md:pt-16 lg:px-8 xl:max-w-[1760px]"
      data-testid="home-info-section"
    >
      <div className="mx-auto max-w-3xl text-center">
        <p className="eyebrow">{APP_NAME}</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-white md:text-4xl md:leading-[44px]">
          Build. Explore. Trade. Earn with AI on Base.
        </h2>

        {/* Supporting agent description — moved here from the hero so the
            top of Home stays spacious and focused. */}
        <p className="mt-4 text-sm leading-relaxed text-white/70 md:text-[15px]">
          {STOCKS_AGENT_SUBTITLE}{" "}
          <span className="font-semibold text-white">{STOCKS_AGENT_SIGN_LINE}</span>
        </p>

        <p className="mt-5 text-sm leading-relaxed text-muted">
          {APP_NAME} is a Base-native on-chain platform combining an AI agent
          with market intelligence, tokenized-asset research, transaction
          preparation and x402-enabled services, games and ecosystem
          utilities — with execution remaining under the user&rsquo;s control.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          The agent reads live Coinbase wrapped-asset and tokenized-stock
          data, prepares each action for explicit review, and can settle
          small paid data requests over the x402 protocol. Nothing is
          signed until you confirm it in your wallet.
        </p>
        <p className="mt-6 text-[11px] font-medium tracking-wide text-muted/80">
          Built on Base <span className="text-white/25">•</span> Powered by
          on-chain infrastructure <span className="text-white/25">•</span>{" "}
          User-controlled execution
        </p>
      </div>

      <div className="mt-10 grid gap-3 sm:gap-4 md:grid-cols-3">
        {CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <GlassCard
              key={card.title}
              className="p-6 transition-colors duration-300 hover:border-white/[0.12]"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/[0.16] bg-primary/[0.07]">
                  <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                </span>
                <p className="text-[15px] font-semibold tracking-[-0.01em] text-white">
                  {card.title}
                </p>
              </div>
              <p className="mt-4 text-[13px] leading-relaxed text-muted">{card.body}</p>
            </GlassCard>
          );
        })}
      </div>

      {/* Non-US / not-financial-advice disclaimer — moved here with the
          rest of the hero's supporting copy; stays always visible. */}
      <p className="mx-auto mt-10 max-w-2xl text-center text-[10px] leading-relaxed text-muted/70">
        {STOCKS_AGENT_DISCLAIMER}
      </p>
    </section>
  );
}
