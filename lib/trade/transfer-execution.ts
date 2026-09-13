// lib/trade/transfer-execution.ts
//
// P — the ONLY module allowed to sign/broadcast a Base send/transfer.
// Invoked solely from an explicit Confirm click (hooks/useTransferQuote).
//
// Simpler than trade-execution.ts: a direct ERC-20 transfer() or native
// send never needs an allowance/approval step or a Permit2 signature —
// the sender is moving their own balance directly. Just:
//   1. Re-check freshness (re-quote if stale, same window as trade)
//   2. sendTransaction(proposal.transaction)
//   3. waitForTransactionReceipt
//
// Never invents calldata — always broadcasts exactly what
// transfer-proposal.ts built server-side.

import { isAddress, type Address, type Hash } from "viem";
import { sendTransaction, waitForTransactionReceipt } from "wagmi/actions";

import { config } from "@/lib/wagmi";
import { TRADE_CHAIN_ID } from "./trade-config";
import { isTransferProposalFresh, TRANSFER_PROPOSAL_MAX_AGE_MS } from "./transfer-freshness";
import { revalidateTransferProposal, type TransferConfirmationState } from "./transfer-confirmation";
import type { TransferError, TransferProposal } from "./transfer-types";

export const TRANSFER_EXECUTION_STATES = [
  "IDLE",
  "READY_FOR_CONFIRMATION",
  "REQUOTING",
  "AWAITING_WALLET",
  "PENDING",
  "SUCCESS",
  "ERROR",
] as const;
export type TransferExecutionState = (typeof TRANSFER_EXECUTION_STATES)[number];

export interface TransferExecutionSnapshot {
  state: TransferExecutionState;
  txHash: Hash | null;
  error: TransferError | null;
  stepLabel: string | null;
}

export function idleTransferExecutionSnapshot(): TransferExecutionSnapshot {
  return { state: "IDLE", txHash: null, error: null, stepLabel: null };
}

function fail(code: TransferError["code"], message: string): TransferExecutionSnapshot {
  return { state: "ERROR", txHash: null, error: { code, message }, stepLabel: null };
}

function classifyWalletError(err: unknown, fallback: TransferError["code"]): TransferError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes("user rejected") ||
    lower.includes("user denied") ||
    lower.includes("request rejected") ||
    lower.includes("rejected the request")
  ) {
    return { code: "WALLET_REJECTED", message: "The wallet request was cancelled." };
  }
  return { code: fallback, message: "The wallet could not complete this transfer." };
}

export interface ExecuteTransferInput {
  proposal: TransferProposal;
  confirmationState: TransferConfirmationState;
  currentAccount: Address | null | undefined;
  currentChainId: number | null | undefined;
  /** Optional re-quote (re-reads balance/recipient) when the stored proposal is older than TRANSFER_PROPOSAL_MAX_AGE_MS. If omitted and stale, execution aborts. */
  refreshProposal?: (proposal: TransferProposal) => Promise<TransferProposal>;
}

function checkGates(input: ExecuteTransferInput): TransferError | null {
  if (!input.currentAccount || !isAddress(input.currentAccount)) {
    return { code: "WALLET_REQUIRED", message: "Connect your wallet to execute this transfer." };
  }
  if (input.confirmationState !== "READY_FOR_CONFIRMATION") {
    return { code: "INVALID_INPUT", message: "This transfer has not been validated yet — nothing was signed or sent." };
  }
  if (input.currentChainId !== TRADE_CHAIN_ID) {
    return { code: "UNSUPPORTED_NETWORK", message: `Switch to Base Mainnet (chainId ${TRADE_CHAIN_ID}) to execute this transfer.` };
  }
  const revalidated = revalidateTransferProposal(input.proposal, input.currentAccount);
  if (revalidated.state !== "VALIDATED") {
    return revalidated.error ?? { code: "INVALID_INPUT", message: "This transfer is no longer valid." };
  }
  if (input.proposal.sender.toLowerCase() !== input.currentAccount.toLowerCase()) {
    return { code: "WALLET_REQUIRED", message: "This transfer was prepared for a different wallet." };
  }
  return null;
}

// Same shape as trade-execution.ts's `inFlight` Set — a client-side,
// per-tab dedupe guard keyed by account+proposal so a double-click (or a
// re-render that calls execute twice) cannot fire two wallet prompts /
// two on-chain sends for the same prepared transfer. This is on top of,
// not instead of, the UI-level disable — see AgentTransferConfirmationModal.
const inFlight = new Set<string>();

export async function executeTransfer(
  input: ExecuteTransferInput,
  onChange: (snapshot: TransferExecutionSnapshot) => void,
): Promise<TransferExecutionSnapshot> {
  const gate = checkGates(input);
  if (gate) {
    const snapshot = fail(gate.code, gate.message);
    onChange(snapshot);
    return snapshot;
  }

  const account = input.currentAccount as Address;
  const key = `${account}:${input.proposal.id}`;
  if (inFlight.has(key)) {
    const snapshot = fail("SEND_FAILED", "This transfer is already executing.");
    onChange(snapshot);
    return snapshot;
  }
  inFlight.add(key);

  let proposal = input.proposal;

  try {
    if (!isTransferProposalFresh(proposal)) {
      if (!input.refreshProposal) {
        const snapshot = fail(
          "EXECUTION_UNAVAILABLE",
          `This transfer proposal is older than ${TRANSFER_PROPOSAL_MAX_AGE_MS / 1000}s. Re-open it to re-check your balance.`,
        );
        onChange(snapshot);
        return snapshot;
      }
      onChange({ state: "REQUOTING", txHash: null, error: null, stepLabel: "Re-checking balance and recipient…" });
      let fresh: TransferProposal;
      try {
        fresh = await input.refreshProposal(proposal);
      } catch {
        const snapshot = fail("PROVIDER_ERROR", "Could not re-check this transfer before sending.");
        onChange(snapshot);
        return snapshot;
      }
      if (
        fresh.asset.address.toLowerCase() !== proposal.asset.address.toLowerCase() ||
        fresh.recipient.address.toLowerCase() !== proposal.recipient.address.toLowerCase() ||
        fresh.amount !== proposal.amount ||
        fresh.sender.toLowerCase() !== proposal.sender.toLowerCase()
      ) {
        const snapshot = fail("INVALID_INPUT", "The refreshed transfer no longer matches this proposal.");
        onChange(snapshot);
        return snapshot;
      }
      if (!fresh.sufficientBalance) {
        const snapshot = fail("INSUFFICIENT_BALANCE", "Your balance is no longer sufficient for this transfer.");
        onChange(snapshot);
        return snapshot;
      }
      proposal = fresh;
    }

    onChange({ state: "AWAITING_WALLET", txHash: null, error: null, stepLabel: "Sign the transfer in your wallet…" });

    let txHash: Hash;
    try {
      txHash = await sendTransaction(config, {
        account,
        chainId: TRADE_CHAIN_ID,
        to: proposal.transaction.to,
        data: proposal.transaction.data,
        value: BigInt(proposal.transaction.value || "0"),
      });
    } catch (err) {
      const classified = classifyWalletError(err, "SEND_FAILED");
      const snapshot = fail(classified.code, classified.message);
      onChange(snapshot);
      return snapshot;
    }

    onChange({ state: "PENDING", txHash, error: null, stepLabel: "Waiting for Base confirmation…" });

    const receipt = await waitForTransactionReceipt(config, { hash: txHash });
    if (receipt.status !== "success") {
      const snapshot = fail("SEND_FAILED", "The transfer transaction failed on Base.");
      onChange({ ...snapshot, txHash });
      return { ...snapshot, txHash };
    }

    const success: TransferExecutionSnapshot = {
      state: "SUCCESS",
      txHash,
      error: null,
      stepLabel: "Transfer settled on Base.",
    };
    onChange(success);
    return success;
  } finally {
    inFlight.delete(key);
  }
}
