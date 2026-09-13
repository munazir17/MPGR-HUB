// lib/trade/transfer-types.ts
//
// Shared types for Base ETH / ERC-20 "send to address or Basename".
// Amounts are always atomic-unit decimal strings (never invented floats),
// matching lib/trade/trade-types.ts's convention.
//
// A TransferProposal is intentionally NOT a TradeProposal: a transfer has
// one asset and a recipient, not a from/to pair, a quote, or slippage. A
// shared shape would either bloat TradeProposal with transfer-only fields
// or force fake swap fields onto a transfer — both are worse than a
// small parallel type that mirrors the same safety shape (structured,
// server-validated, requiresConfirmation, never signs itself).

import type { Address, Hex } from "viem";
import type { TradeTokenRef, TradeRiskFact } from "./trade-types";

export const TRANSFER_KINDS = ["native-transfer", "erc20-transfer"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

export const TRANSFER_PROPOSAL_PHASES = [
  "idle",
  "validating",
  "awaiting_approval",
  "awaiting_signature",
  "submitting",
  "success",
  "error",
] as const;
export type TransferProposalPhase = (typeof TRANSFER_PROPOSAL_PHASES)[number];

/** How the recipient was supplied. Never a local name->address database — see transfer-basename.ts. */
export const RECIPIENT_INPUT_KINDS = ["address", "basename"] as const;
export type RecipientInputKind = (typeof RECIPIENT_INPUT_KINDS)[number];

export interface ResolvedRecipient {
  /** Exactly what the user/model typed, e.g. "jesse.base.eth" or "0x...". */
  input: string;
  inputKind: RecipientInputKind;
  /** Checksummed destination address. This is the only address execution ever uses. */
  address: Address;
  /** Present only when inputKind === "basename". */
  basename: string | null;
}

export interface TransferTransaction {
  to: Address;
  data: Hex;
  value: string;
}

export interface TransferProposal {
  id: string;
  kind: TransferKind;
  network: "base";
  chainId: 8453;
  asset: TradeTokenRef;
  amount: string;
  sender: Address;
  recipient: ResolvedRecipient;
  /** Sender's on-chain balance of `asset` at proposal-build time, atomic units. */
  senderBalance: string;
  /** True only when senderBalance >= amount at proposal-build time. Re-checked at confirm time too. */
  sufficientBalance: boolean;
  transaction: TransferTransaction;
  quotedAt: string;
  risk: readonly TradeRiskFact[];
  warnings: readonly string[];
  displayAmount: string;
  description: string;
  requiresConfirmation: true;
  phase: TransferProposalPhase;
}

export interface TransferError {
  code:
    | "INVALID_INPUT"
    | "UNSUPPORTED_NETWORK"
    | "UNSUPPORTED_ASSET"
    | "WALLET_REQUIRED"
    | "INVALID_RECIPIENT"
    | "RECIPIENT_UNRESOLVED"
    | "INSUFFICIENT_BALANCE"
    | "PROVIDER_ERROR"
    | "WALLET_REJECTED"
    | "SEND_FAILED"
    | "EXECUTION_UNAVAILABLE";
  message: string;
}
