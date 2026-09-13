"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useChainId } from "wagmi";

import type { TransferConfirmationState } from "@/lib/trade/transfer-confirmation";
import { executeTransfer, idleTransferExecutionSnapshot } from "@/lib/trade/transfer-execution";
import type { TransferProposal } from "@/lib/trade/transfer-types";

async function refreshProposal(proposal: TransferProposal): Promise<TransferProposal> {
  const response = await fetch("/api/transfer/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      token: proposal.asset.address,
      amount: proposal.amount,
      atomicAmount: proposal.amount,
      recipient: proposal.recipient.input,
    }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as { proposal?: TransferProposal; error?: string } | null;
  if (!response.ok || !payload?.proposal) {
    throw new Error(payload?.error || "Could not refresh the transfer.");
  }
  return payload.proposal;
}

export function useTransferExecution() {
  const { address } = useAccount();
  const chainId = useChainId();
  const [snapshot, setSnapshot] = useState(idleTransferExecutionSnapshot());
  const runIdRef = useRef(0);
  const isActiveRef = useRef(false);

  const execute = useCallback(
    (proposal: TransferProposal, confirmationState: TransferConfirmationState) => {
      if (isActiveRef.current) return;
      const runId = (runIdRef.current += 1);
      isActiveRef.current = true;

      void executeTransfer(
        {
          proposal,
          confirmationState,
          currentAccount: address,
          currentChainId: chainId,
          refreshProposal,
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
    setSnapshot(idleTransferExecutionSnapshot());
  }, []);

  return {
    state: snapshot.state,
    txHash: snapshot.txHash,
    error: snapshot.error,
    stepLabel: snapshot.stepLabel,
    execute,
    reset,
  };
}
