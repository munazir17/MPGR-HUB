// lib/trade/transfer-confirmation.ts
//
// Confirmation state machine for TransferProposal, mirrors
// trade-confirmation.ts exactly:
//   IDLE -> WALLET_REQUIRED
//   IDLE -> VALIDATING -> VALIDATED -> READY_FOR_CONFIRMATION
//                       \-> VALIDATION_FAILED
//
// Stops at READY_FOR_CONFIRMATION. Never signs. Never sends a tx.

import { isAddress, type Address } from "viem";

import { TRADE_CHAIN_ID, TRADE_NETWORK } from "./trade-config";
import type { TransferError, TransferProposal } from "./transfer-types";

export const TRANSFER_CONFIRMATION_STATES = [
  "IDLE",
  "WALLET_REQUIRED",
  "VALIDATING",
  "VALIDATED",
  "READY_FOR_CONFIRMATION",
  "VALIDATION_FAILED",
] as const;
export type TransferConfirmationState = (typeof TRANSFER_CONFIRMATION_STATES)[number];

export interface TransferConfirmationSnapshot {
  state: TransferConfirmationState;
  error: TransferError | null;
}

export function idleTransferConfirmationSnapshot(): TransferConfirmationSnapshot {
  return { state: "IDLE", error: null };
}

function fail(code: TransferError["code"], message: string): TransferConfirmationSnapshot {
  return { state: "VALIDATION_FAILED", error: { code, message } };
}

export function revalidateTransferProposal(
  proposal: TransferProposal,
  account?: Address | null,
): TransferConfirmationSnapshot {
  if (proposal.requiresConfirmation !== true) {
    return fail("INVALID_INPUT", "This transfer proposal is not marked as requiring confirmation.");
  }
  if (proposal.network !== TRADE_NETWORK || proposal.chainId !== TRADE_CHAIN_ID) {
    return fail("UNSUPPORTED_NETWORK", "Only Base Mainnet transfers can be confirmed.");
  }
  if (!isAddress(proposal.sender) || !isAddress(proposal.recipient.address) || !isAddress(proposal.transaction.to)) {
    return fail("INVALID_INPUT", "This proposal's addresses are no longer valid.");
  }
  try {
    if (BigInt(proposal.amount) <= 0n) {
      return fail("INVALID_INPUT", "This proposal's amount is no longer valid.");
    }
  } catch {
    return fail("INVALID_INPUT", "This proposal's amount is no longer valid.");
  }
  if (!proposal.sufficientBalance) {
    return fail(
      "INSUFFICIENT_BALANCE",
      `Your ${proposal.asset.symbol} balance was insufficient as of the last check. Re-open this transfer to re-check your balance.`,
    );
  }
  if (proposal.recipient.address.toLowerCase() === proposal.sender.toLowerCase()) {
    return fail("INVALID_RECIPIENT", "Recipient cannot be your own connected wallet.");
  }
  if (account && account.toLowerCase() !== proposal.sender.toLowerCase()) {
    return fail("WALLET_REQUIRED", "Connect the wallet this transfer was prepared for before confirming.");
  }
  return { state: "VALIDATED", error: null };
}

export async function runTransferConfirmation(
  proposal: TransferProposal,
  account: Address | null | undefined,
  onChange: (snapshot: TransferConfirmationSnapshot) => void,
): Promise<TransferConfirmationSnapshot> {
  if (!account || !isAddress(account)) {
    const snapshot: TransferConfirmationSnapshot = {
      state: "WALLET_REQUIRED",
      error: { code: "WALLET_REQUIRED", message: "Connect your wallet on Base to review this transfer." },
    };
    onChange(snapshot);
    return snapshot;
  }

  onChange({ state: "VALIDATING", error: null });
  const validated = revalidateTransferProposal(proposal, account);
  if (validated.state !== "VALIDATED") {
    onChange(validated);
    return validated;
  }
  const ready: TransferConfirmationSnapshot = { state: "READY_FOR_CONFIRMATION", error: null };
  onChange(ready);
  return ready;
}
