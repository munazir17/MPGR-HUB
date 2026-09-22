"use client";

// app/page.tsx — Home = MPGR AGENT.
//
// The Base Stocks terminal that used to live at "/agent" was moved
// here; there is no separate Stocks tab/page anymore (bottom nav is
// Home | Rewards | Profile, and /agent redirects to "/"). The agent
// keeps its name — MPGR AGENT — the stocks tooling simply lives inside
// it now.
//
// The page flows naturally (no forced viewport heights, no stretch):
//
//   1. LiveTape — full width, dark, monospace prices, pause on hover
//   2. MPGR AGENT hero + the ONE chat surface (conversation thread +
//      suggested chips + "Ask anything..." composer in a single card),
//      wide on desktop (xl:max-w-[1760px]) so the chat is the primary
//      content of the page
//   3. Compact MPGR HUB info section (brand message + 3 cards)
//   4. Social/community footer
//
//   Pair sheet = right drawer on desktop, bottom sheet on mobile
//   (owned by LiveTape). Wallet button stays in the existing Navbar.

import { useCallback, useRef } from "react";

import { Navbar } from "@/components/Navbar";
import { LiveTape } from "@/components/markets/LiveTape";
import { AgentExperience } from "@/components/features/agent/AgentExperience";
import { StocksAgentHero } from "@/components/features/agent/StocksAgentHero";
import { HomeInfoSection } from "@/components/layout/HomeInfoSection";
import { HomeFooter } from "@/components/layout/HomeFooter";
import {
  STOCKS_AGENT_CHIPS,
  STOCKS_AGENT_EMPTY_STATE,
} from "@/lib/agent-stocks-config";

export default function HomePage() {
  const sendRef = useRef<((prompt: string) => void) | null>(null);

  const handleReady = useCallback((api: { sendMessage: (prompt: string) => void }) => {
    sendRef.current = api.sendMessage;
  }, []);

  const handlePrepareSwap = useCallback((symbol: string) => {
    const send = sendRef.current;
    if (!send) return;
    send(
      `Prepare a swap of 10 USDC to ${symbol} on Base. Show minOut, route, price impact and fees — I will sign in my wallet.`,
    );
  }, []);

  const heroSlot = useCallback(
    (statuses: Parameters<typeof StocksAgentHero>[0]["statuses"]) => (
      <StocksAgentHero statuses={statuses} />
    ),
    [],
  );

  return (
    <div className="flex flex-col">
      <Navbar />
      <LiveTape onPrepareSwap={handlePrepareSwap} />
      <AgentExperience
        heroSlot={heroSlot}
        suggestions={STOCKS_AGENT_CHIPS}
        emptyStateText={STOCKS_AGENT_EMPTY_STATE}
        onReady={handleReady}
      />
      <HomeInfoSection />
      <HomeFooter />
    </div>
  );
}
