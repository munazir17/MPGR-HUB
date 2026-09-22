"use client";

// app/page.tsx — Home = the MPGR AGENT stage.
//
// The product IS the agent, so the first screen IS its workstation:
//
//   1. Navbar (sticky) + LiveTape — the only chrome above the stage
//   2. THE STAGE (AgentExperience) — a viewport-height agent workspace:
//      top bar (folded hero) + body (3D core / thread) + dock (composer).
//      The tape's "Prepare swap" injects the same prompt into the chat.
//   3. Compact MPGR HUB info section (frames + existing copy) + footer —
//      deliberately BELOW the fold, visually secondary
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

  // The hero renders INSIDE the stage's top bar (its testid moves with
  // it — stocks-agent-hero still exists, now in the bar). `thread` lets
  // it swap the big empty-state core for the 28px jewel.
  const heroSlot = useCallback(
    (
      statuses: Parameters<typeof StocksAgentHero>[0]["statuses"],
      opts: { thread: boolean },
    ) => <StocksAgentHero statuses={statuses} thread={opts.thread} />,
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
