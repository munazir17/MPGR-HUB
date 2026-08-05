// lib/token/transaction-service.ts

import type { Address } from "viem";
import { balanceService } from "./balance-service";
import { tokenUtils } from "./token-utils";
import type { TokenBalance } from "./token-types";

// Phase 3E Part 1 — Transaction Service.
//
// Helpers for estimating balances after transactions, computing deltas,
// and validating transaction feasibility. Called after on-chain events
// to update local state and help users understand the impact of their actions.

export const transactionService = {
  // Estimates a balance after a theoretical token transfer, without hitting
  // the blockchain. Useful for optimistic updates in the UI.
  async estimateBalanceAfterTransfer(
    walletAddress: Address,
    sendAmount: string,
    decimals: number
  ): Promise<{ newBalance: TokenBalance; delta: bigint } | null> {
    try {
      const currentRaw = await balanceService.getRawBalance(walletAddress);
      const sendRaw = tokenUtils.parseTokenAmount(sendAmount, decimals);

      if (sendRaw > currentRaw) {
        console.warn("transactionService.estimateBalanceAfterTransfer: insufficient balance", {
          walletAddress,
          sendAmount,
          currentBalance: currentRaw.toString(),
        });
        return null;
      }

      const newRaw = currentRaw - sendRaw;
      return {
        newBalance: {
          raw: newRaw,
          formatted: tokenUtils.formatTokenAmount(newRaw, decimals),
          decimal: decimals,
        },
        delta: tokenUtils.getBalanceDelta(currentRaw, newRaw),
      };
    } catch (err) {
      console.error("transactionService.estimateBalanceAfterTransfer failed", {
        walletAddress,
        sendAmount,
        error: err,
      });
      return null;
    }
  },

  // Validates that a send amount is feasible given the current balance.
  async validateSendAmount(
    walletAddress: Address,
    sendAmount: string,
    decimals: number
  ): Promise<{ isValid: boolean; reason?: string }> {
    try {
      if (!tokenUtils.isValidBalanceString(sendAmount)) {
        return { isValid: false, reason: "Invalid amount format" };
      }

      const currentRaw = await balanceService.getRawBalance(walletAddress);
      const sendRaw = tokenUtils.parseTokenAmount(sendAmount, decimals);

      if (sendRaw <= 0n) {
        return { isValid: false, reason: "Amount must be greater than zero" };
      }

      if (sendRaw > currentRaw) {
        return { isValid: false, reason: "Insufficient balance" };
      }

      return { isValid: true };
    } catch (err) {
      console.error("transactionService.validateSendAmount failed", {
        walletAddress,
        sendAmount,
        error: err,
      });
      return { isValid: false, reason: "Validation failed" };
    }
  },

  // Resets cached balance after a confirmed transaction (so next query
  // fetches fresh data from RPC instead of returning stale cache).
  invalidateBalance(walletAddress: Address): void {
    balanceService.clearCache(walletAddress);
  },
} as const;
