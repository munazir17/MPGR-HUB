// lib/swap/v2/v2-settlement-client.ts
// Client half of V2 receipt verification.
//
// The authoritative check happens server-side (/api/swap/v2/settlement), which
// re-fetches the transaction and receipt from Base by hash, reads the executor's
// live fee posture AT THE MINED BLOCK, re-derives the intent from the mined
// calldata, and only then compares the receipt's own events. A browser cannot do
// that as strongly, and a client-supplied receipt must never be self-certified.
//
// Fail-closed: any transport, shape or attribution problem yields an UNVERIFIED
// result plus an error, so the UI can never show a swap as settled on doubt.
import type { Address } from "viem";
import type { TradeError } from "@/lib/trade/trade-types";
import type { SwapSettlement } from "@/lib/swap/swap-policy";

export interface SwapV2SettlementResult {
  settlement: SwapSettlement;
  /** Non-null when the swap must NOT be reported as settled. */
  error: TradeError | null;
  code: string;
}

const unverified = (reason: string, code: string, error: TradeError | null): SwapV2SettlementResult => ({
  settlement: { verified: false, amountIn: null, amountOut: null, feeAmount: null, feeRecipient: null, reason },
  error,
  code,
});

interface SettlementResponse {
  code?: string;
  verified?: boolean;
  error?: string;
  amountIn?: string; amountOut?: string; feeAmount?: string;
  feeBps?: number; feeRecipient?: string; intentId?: string;
  entry?: string; hops?: number; blockNumber?: string;
}

/** Verifies a broadcast V2 swap from its transaction hash. */
export async function verifySwapV2SettlementRemote(
  transactionHash: string,
  signal?: AbortSignal,
): Promise<SwapV2SettlementResult> {
  let response: Response;
  try {
    response = await fetch("/api/swap/v2/settlement", {
      method: "POST", credentials: "include", cache: "no-store", signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ transactionHash }),
    });
  } catch {
    return unverified(
      "Swap submitted, but its settlement could not be verified yet. Check status; do not resubmit.",
      "PROVIDER_ERROR",
      { code: "PROVIDER_ERROR", message: "Swap submitted. Settlement verification is unavailable right now. Check status; do not resubmit." },
    );
  }
  const payload = (await response.json().catch(() => null)) as SettlementResponse | null;
  const code = typeof payload?.code === "string" ? payload.code : "INVALID_RESPONSE";

  if (!response.ok || !payload || payload.verified !== true) {
    const reason = typeof payload?.error === "string" && payload.error.length > 0
      ? payload.error
      : "Settlement could not be verified. Do not resubmit; inspect the transaction on BaseScan.";
    // A reverted transaction is a real outcome, not a provider problem. The
    // activity log maps SEND_FAILED to "reverted", so use it for that case.
    const tradeCode: TradeError["code"] = code === "TRANSACTION_REVERTED" ? "SEND_FAILED" : "PROVIDER_ERROR";
    return unverified(reason, code, { code: tradeCode, message: reason });
  }

  const { amountIn, amountOut, feeAmount, feeRecipient } = payload;
  if (typeof amountIn !== "string" || typeof amountOut !== "string" ||
      typeof feeAmount !== "string" || typeof feeRecipient !== "string") {
    return unverified(
      "The server verified the swap but returned incomplete settlement evidence. Check status; do not resubmit.",
      code,
      { code: "PROVIDER_ERROR", message: "Settlement evidence was incomplete. Check status; do not resubmit." },
    );
  }
  return {
    settlement: {
      verified: true,
      amountIn,
      amountOut,
      feeAmount,
      feeRecipient: feeRecipient as Address,
      reason: null,
    },
    error: null,
    code,
  };
}
