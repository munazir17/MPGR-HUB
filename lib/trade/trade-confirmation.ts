// lib/trade/trade-confirmation.ts
//
// P4 confirmation state machine. Mirrors x402-confirmation.ts:
//   IDLE -> WALLET_REQUIRED
//   IDLE -> VALIDATING -> VALIDATED -> READY_FOR_CONFIRMATION
//                       \-> VALIDATION_FAILED
//
// Stops at READY_FOR_CONFIRMATION. Never signs. Never sends a tx.

import { isAddress, type Address } from "viem";

import {
  TRADE_CHAIN_ID,
  TRADE_MAX_SLIPPAGE_BPS,
  TRADE_MIN_SLIPPAGE_BPS,
  TRADE_NETWORK,
} from "./trade-config";
import type { TradeError, TradeProposal } from "./trade-types";

export const TRADE_CONFIRMATION_STATES = [
  "IDLE",
  "WALLET_REQUIRED",
  "VALIDATING",
  "VALIDATED",
  "READY_FOR_CONFIRMATION",
  "VALIDATION_FAILED",
] as const;
export type TradeConfirmationState = (typeof TRADE_CONFIRMATION_STATES)[number];

export interface TradeConfirmationSnapshot {
  state: TradeConfirmationState;
  error: TradeError | null;
}

export function idleTradeConfirmationSnapshot(): TradeConfirmationSnapshot {
  return { state: "IDLE", error: null };
}

function fail(code: TradeError["code"], message: string): TradeConfirmationSnapshot {
  return { state: "VALIDATION_FAILED", error: { code, message } };
}

export function revalidateTradeProposal(
  proposal: TradeProposal,
  account?: Address | null,
): TradeConfirmationSnapshot {
  if (proposal.requiresConfirmation !== true) {
    return fail("INVALID_INPUT", "This trade proposal is not marked as requiring confirmation.");
  }
  if (proposal.network !== TRADE_NETWORK || proposal.chainId !== TRADE_CHAIN_ID) {
    return fail("UNSUPPORTED_NETWORK", "Only Base Mainnet swaps can be confirmed.");
  }
  if (proposal.provider !== "cdp-trade-api") {
    return fail("PROVIDER_ERROR", "This proposal was not built from the Coinbase CDP Trade API.");
  }
  if (!isAddress(proposal.taker) || !isAddress(proposal.from.address) || !isAddress(proposal.to.address)) {
    return fail("INVALID_INPUT", "This proposal's addresses are no longer valid.");
  }
  if (
    proposal.slippageBps < TRADE_MIN_SLIPPAGE_BPS ||
    proposal.slippageBps > TRADE_MAX_SLIPPAGE_BPS
  ) {
    return fail("INVALID_INPUT", "This proposal's slippage is outside the allowed range.");
  }
  try {
    if (BigInt(proposal.fromAmount) <= 0n) {
      return fail("INVALID_INPUT", "This proposal's amount is no longer valid.");
    }
  } catch {
    return fail("INVALID_INPUT", "This proposal's amount is no longer valid.");
  }
  if (!proposal.liquidityAvailable || !proposal.executionAvailable || !proposal.transaction) {
    return fail(
      "EXECUTION_UNAVAILABLE",
      "Coinbase CDP did not return an executable swap for this pair. Research only — nothing will be signed.",
    );
  }
  if (account && account.toLowerCase() !== proposal.taker.toLowerCase()) {
    return fail(
      "WALLET_REQUIRED",
      "Connect the wallet this quote was prepared for before confirming.",
    );
  }
  return { state: "VALIDATED", error: null };
}

export async function runTradeConfirmation(
  proposal: TradeProposal,
  account: Address | null | undefined,
  onChange: (snapshot: TradeConfirmationSnapshot) => void,
): Promise<TradeConfirmationSnapshot> {
  if (!account || !isAddress(account)) {
    const snapshot: TradeConfirmationSnapshot = {
      state: "WALLET_REQUIRED",
      error: {
        code: "WALLET_REQUIRED",
        message: "Connect your wallet on Base to review this swap.",
      },
    };
    onChange(snapshot);
    return snapshot;
  }

  onChange({ state: "VALIDATING", error: null });
  const validated = revalidateTradeProposal(proposal, account);
  if (validated.state !== "VALIDATED") {
    onChange(validated);
    return validated;
  }
  const ready: TradeConfirmationSnapshot = {
    state: "READY_FOR_CONFIRMATION",
    error: null,
  };
  onChange(ready);
  return ready;
}
