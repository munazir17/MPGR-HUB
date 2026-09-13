"use client";

import { useCallback, useEffect, useState } from "react";

import { useTransferConfirmation } from "./useTransferConfirmation";
import { useTransferExecution } from "./useTransferExecution";
import type { TransferProposal } from "@/lib/trade/transfer-types";

export function useTransferQuote(onTransferSuccess?: (proposal: TransferProposal, txHash: `0x${string}`) => void) {
  const [proposal, setProposal] = useState<TransferProposal | null>(null);

  const {
    state: confirmationState,
    error: confirmationError,
    run: runConfirmation,
    reset: resetConfirmation,
  } = useTransferConfirmation();

  const {
    state: executionState,
    txHash,
    error: executionError,
    stepLabel,
    execute,
    reset: resetExecution,
  } = useTransferExecution();

  const openProposal = useCallback(
    (next: TransferProposal) => {
      resetExecution();
      setProposal(next);
      runConfirmation(next);
    },
    [resetExecution, runConfirmation],
  );

  const confirmAndSend = useCallback(() => {
    if (!proposal) return;
    if (confirmationState !== "READY_FOR_CONFIRMATION") return;
    execute(proposal, confirmationState);
  }, [proposal, confirmationState, execute]);

  useEffect(() => {
    if (executionState !== "SUCCESS" || !proposal || !txHash) return;
    onTransferSuccess?.(proposal, txHash);
  }, [executionState, proposal, txHash, onTransferSuccess]);

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
    txHash,
    stepLabel,
    openProposal,
    confirmAndSend,
    close,
  };
}
