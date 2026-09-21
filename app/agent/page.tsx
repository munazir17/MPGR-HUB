"use client";

// app/agent/page.tsx
//
// Base Stocks Agent — a trading terminal, not a chatbot landing page.
//
// Layout (top → bottom):
//   1. LiveTape — full width, dark, monospace prices, pause on hover
//   2. Title + one-line subtitle + always-visible non-US disclaimer
//   3. Suggested chips in one wrap row (stocks prompts only — no XP/
//      season/rewards chips; those tools still answer if asked)
//   4. Chat thread with the input always visible at the bottom
//   Pair sheet = right drawer on desktop, bottom sheet on mobile
//   (owned by LiveTape). Wallet button stays in the existing Navbar.
//
// The MPGR/XP/gaming home experience at "/" is untouched.

import { useCallback, useRef } from "react";

import { Navbar } from "@/components/Navbar";
import { LiveTape } from "@/components/markets/LiveTape";
import { AgentExperience } from "@/components/features/agent/AgentExperience";
import { StocksAgentHero } from "@/components/features/agent/StocksAgentHero";
import {
  STOCKS_AGENT_CHIPS,
  STOCKS_AGENT_EMPTY_STATE,
} from "@/lib/agent-stocks-config";

export default function AgentPage() {
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
      <div className="flex min-h-[calc(100dvh-5rem)] flex-1 flex-col md:min-h-0">
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
    </div>
  );
}
