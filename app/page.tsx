"use client";

// app/page.tsx — Home = MPGR AGENT.
//
// The Base Stocks terminal that used to live at "/agent" was moved
// here; there is no separate Stocks tab/page anymore (bottom nav is
// Home | Rewards | Profile, and /agent redirects to "/"). The agent
// keeps its name — MPGR AGENT — the stocks tooling simply lives inside
// it now.
//
// Layout (top → bottom, content-driven — no forced viewport heights):
//   1. LiveTape — full width, dark, monospace prices, pause on hover
//   2. MPGR AGENT hero: title + one-line subtitle + always-visible
//      non-US disclaimer
//   3. ONE unified chat: "Conversation" thread (when messages exist),
//      the canonical suggested chips and the "Ask anything..." composer
//      rendered together in one composer card. The thread sizes to its
//      content (compact with few messages, capped + scrolling when long)
//      so there is never a huge empty panel under the last message.
//   4. Existing social/community footer.
//   Pair sheet = right drawer on desktop, bottom sheet on mobile
//   (owned by LiveTape). Wallet button stays in the existing Navbar.
//
// The agent column widens on desktop (lg:max-w-5xl) so the chat is a
// real desktop workspace instead of a stretched mobile column.

import { useCallback, useRef } from "react";

import { Navbar } from "@/components/Navbar";
import { LiveTape } from "@/components/markets/LiveTape";
import { AgentExperience } from "@/components/features/agent/AgentExperience";
import { StocksAgentHero } from "@/components/features/agent/StocksAgentHero";
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
    <div className="flex min-h-[100dvh] flex-col">
      <Navbar />
      <div className="flex flex-1 flex-col">
        <LiveTape onPrepareSwap={handlePrepareSwap} />
        <AgentExperience
          heroSlot={heroSlot}
          suggestions={STOCKS_AGENT_CHIPS}
          emptyStateText={STOCKS_AGENT_EMPTY_STATE}
          hideMarketTicker
          hideQuickActions
          onReady={handleReady}
        />
      </div>
      <HomeFooter />
    </div>
  );
}
