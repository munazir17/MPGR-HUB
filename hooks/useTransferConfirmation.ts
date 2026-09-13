"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount } from "wagmi";

import {
  idleTransferConfirmationSnapshot,
  runTransferConfirmation,
  type TransferConfirmationState,
} from "@/lib/trade/transfer-confirmation";
import type { TransferError, TransferProposal } from "@/lib/trade/transfer-types";

export function useTransferConfirmation() {
  const { address } = useAccount();
  const [snapshot, setSnapshot] = useState(idleTransferConfirmationSnapshot());
  const runIdRef = useRef(0);

  const run = useCallback(
    (proposal: TransferProposal) => {
      const runId = (runIdRef.current += 1);
      void runTransferConfirmation(proposal, address, (next) => {
        if (runIdRef.current === runId) setSnapshot(next);
      });
    },
    [address],
  );

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setSnapshot(idleTransferConfirmationSnapshot());
  }, []);

  return {
    state: snapshot.state as TransferConfirmationState,
    error: snapshot.error as TransferError | null,
    canConfirm: snapshot.state === "READY_FOR_CONFIRMATION",
    run,
    reset,
  };
}
