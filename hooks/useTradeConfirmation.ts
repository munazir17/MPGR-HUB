"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount } from "wagmi";

import {
  idleTradeConfirmationSnapshot,
  runTradeConfirmation,
  type TradeConfirmationState,
} from "@/lib/trade/trade-confirmation";
import type { TradeError, TradeProposal } from "@/lib/trade/trade-types";

export function useTradeConfirmation() {
  const { address } = useAccount();
  const [snapshot, setSnapshot] = useState(idleTradeConfirmationSnapshot());
  const runIdRef = useRef(0);

  const run = useCallback(
    (proposal: TradeProposal) => {
      const runId = (runIdRef.current += 1);
      void runTradeConfirmation(proposal, address, (next) => {
        if (runIdRef.current === runId) setSnapshot(next);
      });
    },
    [address],
  );

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setSnapshot(idleTradeConfirmationSnapshot());
  }, []);

  return {
    state: snapshot.state as TradeConfirmationState,
    error: snapshot.error as TradeError | null,
    canConfirm: snapshot.state === "READY_FOR_CONFIRMATION",
    run,
    reset,
  };
}
