// lib/autonomy/verify.ts
//
// Verification engine (spec §15). Every autonomous execution is verified
// through the EXISTING MCP verification (mpgr_get_trade_status +
// mpgr_verify_trade → verifyExecutorReceipt), which proves from the on-chain
// receipt: executor event, taker, tokens, gross amount, EXACT fee to the fee
// recipient, and output >= minBuyAmount.
//
// This module adds the runtime verdict semantics:
//   VERIFIED   — MCP verified === true (never anything else)
//   FAILED     — receipt reverted, or verified === false
//   UNCERTAIN  — no receipt yet, attempts exhausted, or RPC errors
//
// A pending/unknown receipt is NEVER reported as success, and a broadcast
// that cannot be verified is never retried with a new transaction.

import type { McpGateway } from "./mcp-gateway";
import type { ExecutionOutcome } from "./types";
import { AUTONOMY_LIMITS } from "./config";

export interface VerificationInput {
  chainId: number;
  quoteId: string;
  txHash: string;
  expectedBuyAmountRaw: string;
  minBuyAmountRaw: string;
  attemptsSoFar: number;
  /** Delegated path ONLY: broadcaster address for scoped tx.from semantics. */
  expectedSender?: string;
  /**
   * Delegated path ONLY: the signed witness actionId — the executor requires
   * call intentId == actionId, so the SwapExecuted event carries this, never
   * the quote-derived intent id.
   */
  expectedIntentId?: string;
}

export interface VerificationVerdict {
  outcome: ExecutionOutcome | "PENDING_VERIFICATION";
  verified: boolean;
  actualBuyAmountRaw?: string;
  feeAmountRaw?: string;
  blockNumber?: string;
  code: "VERIFIED" | "TX_REVERTED" | "VERIFICATION_FAILED" | "TIMEOUT" | "RPC_ERROR";
  message: string;
}

export async function verifyExecution(gateway: McpGateway, input: VerificationInput): Promise<VerificationVerdict> {
  // Hard stop: attempts exhausted -> uncertain, never success, never retry-by-resubmit.
  if (input.attemptsSoFar >= AUTONOMY_LIMITS.maxVerificationAttempts) {
    return {
      outcome: "UNCERTAIN",
      verified: false,
      code: "TIMEOUT",
      message: `No confirmable receipt after ${input.attemptsSoFar} verification attempts. The transaction is marked uncertain and will NOT be retried automatically.`,
    };
  }

  let status;
  try {
    status = await gateway.status(input.chainId, input.txHash);
  } catch {
    return {
      outcome: "PENDING_VERIFICATION",
      verified: false,
      code: "RPC_ERROR",
      message: "Transaction status check failed (RPC). Will verify again on the next scheduled pass.",
    };
  }
  if (!status.ok) {
    return {
      outcome: "PENDING_VERIFICATION",
      verified: false,
      code: "RPC_ERROR",
      message: "Transaction status unavailable. Will verify again on the next scheduled pass.",
    };
  }

  if (status.data.status === "pending_or_unknown") {
    return {
      outcome: "PENDING_VERIFICATION",
      verified: false,
      code: "RPC_ERROR",
      message: "Transaction is not yet confirmable on-chain.",
    };
  }

  if (status.data.status === "reverted") {
    return {
      outcome: "FAILED",
      verified: false,
      blockNumber: status.data.blockNumber,
      code: "TX_REVERTED",
      message: "The transaction reverted on-chain. No output was received; the goal will NOT re-trade automatically on this slot.",
    };
  }

  // Receipt is confirmed — prove it matched the quote via MCP verification.
  let verification;
  try {
    verification = await gateway.verify(input.quoteId, input.txHash, input.expectedSender, input.expectedIntentId);
  } catch {
    return {
      outcome: "PENDING_VERIFICATION",
      verified: false,
      blockNumber: status.data.blockNumber,
      code: "RPC_ERROR",
      message: "Receipt read succeeded but verification errored. Will verify again on the next scheduled pass.",
    };
  }
  if (!verification.ok) {
    // e.g. TX_NOT_FOUND race — treat as pending unless attempts are exhausted.
    const exhausted = input.attemptsSoFar + 1 >= AUTONOMY_LIMITS.maxVerificationAttempts;
    return {
      outcome: exhausted ? "UNCERTAIN" : "PENDING_VERIFICATION",
      verified: false,
      blockNumber: status.data.blockNumber,
      code: exhausted ? "TIMEOUT" : "RPC_ERROR",
      message: exhausted
        ? "Verification could not complete within the attempt budget. Marked uncertain; no automatic retry."
        : "Verification could not complete yet. Will verify again on the next scheduled pass.",
    };
  }

  if (verification.data.verified !== true) {
    const failedChecks = verification.data.checks.filter((c) => !c.ok).map((c) => c.name);
    return {
      outcome: "FAILED",
      verified: false,
      actualBuyAmountRaw: verification.data.actualBuyAmountRaw,
      feeAmountRaw: verification.data.feeAmountRaw,
      blockNumber: verification.data.blockNumber,
      code: "VERIFICATION_FAILED",
      message: `Receipt confirmed but did NOT match the prepared intent${failedChecks.length ? ` (failed: ${failedChecks.join(", ")})` : ""}. Reported as failed — never as success.`,
    };
  }

  // Receipt verified. One deterministic output sanity check of our own:
  // actual output must still be >= the min we prepared for.
  const actual = verification.data.actualBuyAmountRaw;
  if (actual !== undefined && /^\d+$/.test(actual) && /^\d+$/.test(input.minBuyAmountRaw) && BigInt(actual) < BigInt(input.minBuyAmountRaw)) {
    return {
      outcome: "FAILED",
      verified: false,
      actualBuyAmountRaw: actual,
      feeAmountRaw: verification.data.feeAmountRaw,
      blockNumber: verification.data.blockNumber,
      code: "VERIFICATION_FAILED",
      message: "Verified receipt output is below the prepared minimum. Reported as failed — never as success.",
    };
  }

  return {
    outcome: "VERIFIED",
    verified: true,
    actualBuyAmountRaw: verification.data.actualBuyAmountRaw,
    feeAmountRaw: verification.data.feeAmountRaw,
    blockNumber: verification.data.blockNumber,
    code: "VERIFIED",
    message: "Transaction confirmed and verified against the quote (executor event, tokens, fee, min output).",
  };
}
