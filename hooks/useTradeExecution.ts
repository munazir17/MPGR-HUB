"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useChainId } from "wagmi";

import type { TradeConfirmationState } from "@/lib/trade/trade-confirmation";
import {
  executeTrade,
  idleTradeExecutionSnapshot,
} from "@/lib/trade/trade-execution";
import type { TradeProposal } from "@/lib/trade/trade-types";

async function refreshQuote(proposal: TradeProposal): Promise<TradeProposal> {
  const response = await fetch("/api/trade/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      fromToken: proposal.from.address,
      toToken: proposal.to.address,
      fromAmount: proposal.fromAmount,
      taker: proposal.taker,
      slippageBps: proposal.slippageBps,
    }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | { proposal?: TradeProposal; error?: string }
    | null;
  if (!response.ok || !payload?.proposal) {
    throw new Error(payload?.error || "Could not refresh the Coinbase CDP quote.");
  }
  return payload.proposal;
}

export function useTradeExecution() {
  const { address } = useAccount();
  const chainId = useChainId();
  const [snapshot, setSnapshot] = useState(idleTradeExecutionSnapshot());
  const runIdRef = useRef(0);
  const isActiveRef = useRef(false);

  const execute = useCallback(
    (proposal: TradeProposal, confirmationState: TradeConfirmationState) => {
      if (isActiveRef.current) return;
      const runId = (runIdRef.current += 1);
      isActiveRef.current = true;

      void executeTrade(
        {
          proposal,
          confirmationState,
          currentAccount: address,
          currentChainId: chainId,
          refreshQuote,
        },
        (next) => {
          if (runIdRef.current !== runId) return;
          setSnapshot(next);
          if (next.state === "SUCCESS" || next.state === "ERROR") {
            isActiveRef.current = false;
          }
        },
      ).catch(() => {
        if (runIdRef.current === runId) isActiveRef.current = false;
      });
    },
    [address, chainId],
  );

  const reset = useCallback(() => {
    runIdRef.current += 1;
    isActiveRef.current = false;
    setSnapshot(idleTradeExecutionSnapshot());
  }, []);

  return {
    state: snapshot.state,
    approvalHash: snapshot.approvalHash,
    swapHash: snapshot.swapHash,
    error: snapshot.error,
    stepLabel: snapshot.stepLabel,
    execute,
    reset,
  };
}
