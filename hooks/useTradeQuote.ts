"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useTradeConfirmation } from "./useTradeConfirmation";
import { useTradeExecution } from "./useTradeExecution";
import type { TradeProposal } from "@/lib/trade/trade-types";

export function useTradeQuote(
  onSwapSuccess?: (
    proposal: TradeProposal,
    swapHash: `0x${string}`,
    approvalHash: `0x${string}` | null,
  ) => void,
) {
  const [proposal, setProposal] = useState<TradeProposal | null>(null);

  const {
    state: confirmationState,
    error: confirmationError,
    run: runConfirmation,
    reset: resetConfirmation,
  } = useTradeConfirmation();

  const {
    state: executionState,
    approvalHash,
    swapHash,
    error: executionError,
    stepLabel,
    execute,
    reset: resetExecution,
  } = useTradeExecution();

  const openProposal = useCallback(
    (next: TradeProposal) => {
      resetExecution();
      setProposal(next);
      runConfirmation(next);
    },
    [resetExecution, runConfirmation],
  );

  const confirmAndSwap = useCallback(() => {
    if (!proposal) return;
    if (confirmationState !== "READY_FOR_CONFIRMATION") return;
    execute(proposal, confirmationState);
  }, [proposal, confirmationState, execute]);

  const reportedSwaps = useRef(new Set<string>());
  useEffect(() => {
    if (executionState !== "SUCCESS" || !proposal || !swapHash) return;
    if (reportedSwaps.current.has(swapHash)) return;
    reportedSwaps.current.add(swapHash);
    onSwapSuccess?.(proposal, swapHash, approvalHash);
  }, [executionState, proposal, swapHash, approvalHash, onSwapSuccess]);

  const close = useCallback(() => {
    setProposal(null);
    resetConfirmation();
    resetExecution();
  }, [resetConfirmation, resetExecution]);

  return {
    proposal,
    open: proposal !== null,
    confirmationState,
    confirmationError,
    executionState,
    executionError,
    approvalHash,
    swapHash,
    stepLabel,
    openProposal,
    confirmAndSwap,
    close,
  };
}
