// lib/trade/trade-execution.ts
//
// P4 — the ONLY module allowed to sign/broadcast a CDP swap.
// Invoked solely from an explicit Confirm click (hooks/useTradeQuote).
//
// Multi-step, matching CDP BYO-wallet docs:
//   1. ERC-20 approve(Permit2) when issues.allowance is set
//   2. Sign Permit2 EIP-712 when quote.permit2 is set
//   3. Append signature to calldata
//   4. sendTransaction(quote.transaction)
//
// Re-quotes if the stored quote is stale. Never invents calldata.

import {
  encodeFunctionData,
  isAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  sendTransaction,
  signTypedData,
  waitForTransactionReceipt,
} from "wagmi/actions";

import { erc20Abi } from "@/lib/erc20-abi";
import { config } from "@/lib/wagmi";
import {
  TRADE_CHAIN_ID,
  TRADE_QUOTE_MAX_AGE_MS,
  isNativeEthSentinel,
} from "./trade-config";
import { appendPermit2Signature, stripEip712Domain } from "./trade-permit2";
import { revalidateTradeProposal, type TradeConfirmationState } from "./trade-confirmation";
import { isTradeQuoteFresh } from "./trade-proposal";
import type { CdpPermit2Eip712, TradeError, TradeProposal } from "./trade-types";

export const TRADE_EXECUTION_STATES = [
  "IDLE",
  "READY_FOR_CONFIRMATION",
  "REQUOTING",
  "APPROVING",
  "AWAITING_PERMIT",
  "AWAITING_WALLET",
  "PENDING",
  "SUCCESS",
  "ERROR",
] as const;
export type TradeExecutionState = (typeof TRADE_EXECUTION_STATES)[number];

export interface TradeExecutionSnapshot {
  state: TradeExecutionState;
  approvalHash: Hash | null;
  swapHash: Hash | null;
  error: TradeError | null;
  stepLabel: string | null;
}

export function idleTradeExecutionSnapshot(): TradeExecutionSnapshot {
  return {
    state: "IDLE",
    approvalHash: null,
    swapHash: null,
    error: null,
    stepLabel: null,
  };
}

function fail(code: TradeError["code"], message: string): TradeExecutionSnapshot {
  return {
    state: "ERROR",
    approvalHash: null,
    swapHash: null,
    error: { code, message },
    stepLabel: null,
  };
}

export interface ExecuteTradeInput {
  proposal: TradeProposal;
  confirmationState: TradeConfirmationState;
  currentAccount: Address | null | undefined;
  currentChainId: number | null | undefined;
  /**
   * Optional re-quote. The hook supplies POST /api/trade/quote when the
   * stored quote is older than TRADE_QUOTE_MAX_AGE_MS. If omitted and
   * the quote is stale, execution aborts rather than broadcasting a
   * dead payload.
   */
  refreshQuote?: (proposal: TradeProposal) => Promise<TradeProposal>;
}

const inFlight = new Set<string>();

function classifyWalletError(err: unknown, fallback: TradeError["code"]): TradeError {
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
  return { code: fallback, message: "The wallet could not complete this trade step." };
}

function checkGates(input: ExecuteTradeInput): TradeError | null {
  if (!input.currentAccount || !isAddress(input.currentAccount)) {
    return { code: "WALLET_REQUIRED", message: "Connect your wallet to execute this swap." };
  }
  if (input.confirmationState !== "READY_FOR_CONFIRMATION") {
    return {
      code: "INVALID_INPUT",
      message: "This swap has not been validated yet — nothing was signed or sent.",
    };
  }
  if (input.currentChainId !== TRADE_CHAIN_ID) {
    return {
      code: "UNSUPPORTED_NETWORK",
      message: `Switch to Base Mainnet (chainId ${TRADE_CHAIN_ID}) to execute this swap.`,
    };
  }
  const revalidated = revalidateTradeProposal(input.proposal, input.currentAccount);
  if (revalidated.state !== "VALIDATED") {
    return revalidated.error ?? { code: "INVALID_INPUT", message: "This swap is no longer valid." };
  }
  if (input.proposal.taker.toLowerCase() !== input.currentAccount.toLowerCase()) {
    return {
      code: "WALLET_REQUIRED",
      message: "This quote was prepared for a different wallet.",
    };
  }
  return null;
}

async function signPermit2(eip712: CdpPermit2Eip712, account: Address): Promise<Hex> {
  const types = stripEip712Domain(eip712.types);
  return signTypedData(config, {
    account,
    domain: eip712.domain as never,
    types: types as never,
    primaryType: eip712.primaryType as never,
    message: eip712.message as never,
  });
}

export async function executeTrade(
  input: ExecuteTradeInput,
  onChange: (snapshot: TradeExecutionSnapshot) => void,
): Promise<TradeExecutionSnapshot> {
  const gate = checkGates(input);
  if (gate) {
    const snapshot = fail(gate.code, gate.message);
    onChange(snapshot);
    return snapshot;
  }

  const account = input.currentAccount as Address;
  const key = `${account}:${input.proposal.id}`;
  if (inFlight.has(key)) {
    const snapshot = fail("SEND_FAILED", "This swap is already executing.");
    onChange(snapshot);
    return snapshot;
  }
  inFlight.add(key);

  let proposal = input.proposal;
  let approvalHash: Hash | null = null;

  try {
    if (!isTradeQuoteFresh(proposal)) {
      if (!input.refreshQuote) {
        const snapshot = fail(
          "QUOTE_EXPIRED",
          `This quote is older than ${TRADE_QUOTE_MAX_AGE_MS / 1000}s. Re-open it to fetch a fresh Coinbase route.`,
        );
        onChange(snapshot);
        return snapshot;
      }
      onChange({
        state: "REQUOTING",
        approvalHash: null,
        swapHash: null,
        error: null,
        stepLabel: "Refreshing Coinbase CDP quote…",
      });
      let fresh: TradeProposal;
      try {
        fresh = await input.refreshQuote(proposal);
      } catch {
        const snapshot = fail("PROVIDER_ERROR", "Could not refresh the Coinbase CDP quote.");
        onChange(snapshot);
        return snapshot;
      }
      if (
        fresh.from.address.toLowerCase() !== proposal.from.address.toLowerCase() ||
        fresh.to.address.toLowerCase() !== proposal.to.address.toLowerCase() ||
        fresh.fromAmount !== proposal.fromAmount ||
        fresh.taker.toLowerCase() !== proposal.taker.toLowerCase()
      ) {
        const snapshot = fail("QUOTE_CHANGED", "The refreshed quote no longer matches this proposal.");
        onChange(snapshot);
        return snapshot;
      }
      if (!fresh.executionAvailable || !fresh.transaction) {
        const snapshot = fail("LIQUIDITY_UNAVAILABLE", "Coinbase CDP no longer reports an executable route.");
        onChange(snapshot);
        return snapshot;
      }
      try {
        if (BigInt(fresh.minToAmount) < BigInt(proposal.minToAmount)) {
          const snapshot = fail(
            "QUOTE_CHANGED",
            "The refreshed quote is worse than the one you reviewed. Confirm again to accept the new minimum.",
          );
          onChange(snapshot);
          return snapshot;
        }
      } catch {
        const snapshot = fail("QUOTE_CHANGED", "The refreshed quote could not be compared.");
        onChange(snapshot);
        return snapshot;
      }
      proposal = fresh;
    }

    const tx = proposal.transaction;
    if (!tx) {
      const snapshot = fail("EXECUTION_UNAVAILABLE", "This proposal has no swap transaction.");
      onChange(snapshot);
      return snapshot;
    }

    if (proposal.needsPermit2Approval && proposal.permit2Spender && !isNativeEthSentinel(proposal.from.address)) {
      onChange({
        state: "APPROVING",
        approvalHash: null,
        swapHash: null,
        error: null,
        stepLabel: "Approve Permit2 in your wallet…",
      });
      try {
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [proposal.permit2Spender, BigInt(proposal.fromAmount)],
        });
        approvalHash = await sendTransaction(config, {
          account,
          chainId: TRADE_CHAIN_ID,
          to: proposal.from.address,
          data,
          value: 0n,
        });
        const receipt = await waitForTransactionReceipt(config, { hash: approvalHash });
        if (receipt.status !== "success") {
          const snapshot = fail("APPROVAL_FAILED", "Permit2 approval transaction failed on Base.");
          onChange({ ...snapshot, approvalHash });
          return { ...snapshot, approvalHash };
        }
      } catch (err) {
        const classified = classifyWalletError(err, "APPROVAL_FAILED");
        const snapshot = fail(classified.code, classified.message);
        onChange({ ...snapshot, approvalHash });
        return snapshot;
      }
    }

    let data: Hex = tx.data;
    if (proposal.permit2?.eip712) {
      onChange({
        state: "AWAITING_PERMIT",
        approvalHash,
        swapHash: null,
        error: null,
        stepLabel: "Sign the Permit2 authorization…",
      });
      try {
        const signature = await signPermit2(proposal.permit2.eip712, account);
        data = appendPermit2Signature(data, signature);
      } catch (err) {
        const classified = classifyWalletError(err, "SIGNING_FAILED");
        const snapshot = fail(classified.code, classified.message);
        onChange({ ...snapshot, approvalHash });
        return { ...snapshot, approvalHash };
      }
    }

    onChange({
      state: "AWAITING_WALLET",
      approvalHash,
      swapHash: null,
      error: null,
      stepLabel: "Sign the swap transaction…",
    });

    let swapHash: Hash;
    try {
      swapHash = await sendTransaction(config, {
        account,
        chainId: TRADE_CHAIN_ID,
        to: tx.to,
        data,
        value: BigInt(tx.value || "0"),
        gas: tx.gas ? BigInt(tx.gas) : undefined,
      });
    } catch (err) {
      const classified = classifyWalletError(err, "SEND_FAILED");
      const snapshot = fail(classified.code, classified.message);
      onChange({ ...snapshot, approvalHash });
      return { ...snapshot, approvalHash };
    }

    onChange({
      state: "PENDING",
      approvalHash,
      swapHash,
      error: null,
      stepLabel: "Waiting for Base confirmation…",
    });

    const receipt = await waitForTransactionReceipt(config, { hash: swapHash });
    if (receipt.status !== "success") {
      const snapshot = fail("SEND_FAILED", "The swap transaction failed on Base.");
      onChange({ ...snapshot, approvalHash, swapHash });
      return { ...snapshot, approvalHash, swapHash };
    }

    const success: TradeExecutionSnapshot = {
      state: "SUCCESS",
      approvalHash,
      swapHash,
      error: null,
      stepLabel: "Swap settled on Base.",
    };
    onChange(success);
    return success;
  } finally {
    inFlight.delete(key);
  }
}
