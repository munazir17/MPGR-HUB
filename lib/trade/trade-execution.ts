// lib/trade/trade-execution.ts
//
// P4 — the ONLY module allowed to sign/broadcast a CDP swap.
// Invoked solely from an explicit Confirm click (hooks/useTradeQuote).
//
// Multi-step, matching CDP BYO-wallet docs:
//   1. ERC-20 approve(spender) when issues.allowance is set
//   2. Sign Permit2 EIP-712 when quote.permit2 is set
//   3. Append signature to calldata
//   4. sendTransaction(quote.transaction)
//
// MPGR Executor swaps (provider "mpgr-executor") use the SAME steps, with
// `quote.transaction` targeting MPGRExecutor: approve(gross) when the
// standing allowance to the executor is short, then the executor swap,
// which takes the 25 bps fee from the gross sell amount and swaps the
// remainder. Maximum wallet flow: approve + swap (ERC-20 first time),
// swap only afterwards.
//
// There is NO fee transaction. This module never builds a transfer to a fee
// wallet, never prompts for one, and, when a proposal claims an applied fee,
// it refuses to sign unless the swap transaction provably targets the MPGR
// Executor and commits to the exact displayed fee (see
// verifyAgentFeeInSwapTransaction + inspectExecutorSwapTransaction).
//
// Re-quotes if the stored quote is stale. Never invents calldata.

import {
  encodeFunctionData,
  isAddress,
  type Address,
  type Hash,
  type Hex,
  type TypedDataDomain,
} from "viem";
import {
  readContract,
  sendTransaction,
  signTypedData,
  waitForTransactionReceipt,
} from "wagmi/actions";

import { erc20Abi } from "@/lib/erc20-abi";
import { config } from "@/lib/wagmi";
import { inspectExecutorSwapTransaction } from "@/lib/executor/executor-intent";
import { verifyAgentFeeInSwapTransaction } from "./trade-agent-fee";
import {
  MPGR_EXECUTOR_PROVIDER_ID,
  TRADE_CHAIN_ID,
  TRADE_QUOTE_MAX_AGE_MS,
  isNativeEthSentinel,
} from "./trade-config";
import { appendPermit2Signature, stripEip712Domain } from "./trade-permit2";
import { balanceShortfallMessage, tradeBalanceShortfall } from "./trade-balance";
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

function refreshQuoteLabel(provider: TradeProposal["provider"]): string {
  if (provider === MPGR_EXECUTOR_PROVIDER_ID) return "Refreshing the MPGR Executor quote…";
  if (provider === "aerodrome-slipstream") return "Refreshing Aerodrome quote…";
  if (provider === "0x-swap-api") return "Refreshing 0x quote…";
  return "Refreshing Coinbase CDP quote…";
}

function refreshQuoteFailedMessage(provider: TradeProposal["provider"]): string {
  if (provider === MPGR_EXECUTOR_PROVIDER_ID) return "Could not refresh the MPGR Executor quote.";
  if (provider === "aerodrome-slipstream") return "Could not refresh the Aerodrome quote.";
  if (provider === "0x-swap-api") return "Could not refresh the 0x quote.";
  return "Could not refresh the Coinbase CDP quote.";
}

function approvalStepLabel(proposal: TradeProposal): string {
  if (proposal.provider === MPGR_EXECUTOR_PROVIDER_ID) {
    return "Approve the MPGR Executor in your wallet…";
  }
  if (proposal.provider === "aerodrome-slipstream") {
    return "Approve Aerodrome SwapRouter in your wallet…";
  }
  if (proposal.provider === "0x-swap-api" && !proposal.permit2) {
    return "Approve 0x AllowanceHolder in your wallet…";
  }
  return "Approve Permit2 in your wallet…";
}

function approvalFailedMessage(proposal: TradeProposal): string {
  if (proposal.provider === MPGR_EXECUTOR_PROVIDER_ID) {
    return "The MPGR Executor approval transaction failed on Base.";
  }
  if (proposal.provider === "aerodrome-slipstream") {
    return "Aerodrome SwapRouter approval transaction failed on Base.";
  }
  return "Permit2 approval transaction failed on Base.";
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

/**
 * Live wallet balance of the sell token, read through the connected
 * wallet's own Base transport. `null` means the read itself failed — the
 * caller then falls back to the quote-time read instead of guessing.
 */
async function readLiveBalance(account: Address, token: Address): Promise<bigint | null> {
  try {
    const value = await readContract(config, {
      address: token,
      abi: erc20Abi,
      chainId: TRADE_CHAIN_ID,
      functionName: "balanceOf",
      args: [account],
    });
    return typeof value === "bigint" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Live allowance of `spender` on the sell token. `null` means the read
 * failed, in which case the approval step runs exactly as before
 * (fail-closed toward approving).
 */
async function readLiveAllowance(
  account: Address,
  token: Address,
  spender: Address,
): Promise<bigint | null> {
  try {
    const value = await readContract(config, {
      address: token,
      abi: erc20Abi,
      chainId: TRADE_CHAIN_ID,
      functionName: "allowance",
      args: [account, spender],
    });
    return typeof value === "bigint" ? value : null;
  } catch {
    return null;
  }
}

function parsePositiveAmount(raw: string): bigint | null {
  try {
    const amount = BigInt(raw);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

/**
 * Pre-broadcast funds guard.
 *
 * The quote's balance snapshot is taken during preparation and can be
 * many seconds old by the time the user clicks Confirm — that window is
 * exactly how a swap gets broadcast that the wallet cannot pay for. On
 * the Aerodrome Slipstream route the pool pays tokenOut out first, so
 * the failure surfaces as a bare `STF` (on-chain reason: "ERC20:
 * transfer amount exceeds balance") after gas is spent. Read the live
 * balance here, immediately before any signing prompt.
 *
 * If that read fails (RPC blip), fall back to the quote-time read; an
 * observed shortfall there is still a hard stop. A failed read never
 * invents an approval, a transfer, or extra spend.
 */
async function checkFundsBeforeBroadcast(input: {
  account: Address;
  proposal: TradeProposal;
}): Promise<TradeError | null> {
  const { proposal } = input;
  if (isNativeEthSentinel(proposal.from.address)) return null;

  const required = parsePositiveAmount(proposal.fromAmount);
  if (required === null) {
    return { code: "INVALID_INPUT", message: "This swap amount is not a valid positive amount." };
  }

  const live = await readLiveBalance(input.account, proposal.from.address);
  if (live !== null) {
    if (live < required) {
      return {
        code: "INSUFFICIENT_BALANCE",
        message: balanceShortfallMessage({
          symbol: proposal.from.symbol,
          decimals: proposal.from.decimals,
          shortfall: {
            token: proposal.from.address,
            currentBalance: live.toString(),
            requiredBalance: required.toString(),
          },
        }),
      };
    }
    return null;
  }

  const shortfall = tradeBalanceShortfall(proposal.issues?.balance);
  if (shortfall) {
    return {
      code: "INSUFFICIENT_BALANCE",
      message: balanceShortfallMessage({
        symbol: proposal.from.symbol,
        decimals: proposal.from.decimals,
        shortfall,
      }),
    };
  }
  return null;
}

async function signPermit2(eip712: CdpPermit2Eip712, account: Address): Promise<Hex> {
  // CDP returns Permit2 EIP-712 at runtime (PermitTransferFrom). viem/wagmi
  // generics cannot infer that Record shape — casting individual fields
  // `as never` makes the whole argument `never` and fails `next build`.
  // Strip EIP712Domain (viem injects it), then pass the rest through.
  const types = stripEip712Domain(eip712.types);
  return signTypedData(config, {
    account,
    domain: eip712.domain as TypedDataDomain,
    types,
    primaryType: eip712.primaryType,
    message: eip712.message,
  } as Parameters<typeof signTypedData>[1]);
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
  const key = `\( {account}: \){input.proposal.id}`;
  if (inFlight.has(key)) {
    const snapshot = fail("SEND_FAILED", "This swap is already executing.");
    onChange(snapshot);
    return snapshot;
  }
  inFlight.add(key);

  let proposal = input.proposal;
  let approvalHash: Hash | null = null;
  let swapHash: Hash | null = null;

  try {
    if (!isTradeQuoteFresh(proposal)) {
      if (!input.refreshQuote) {
        const snapshot = fail(
          "QUOTE_EXPIRED",
          `This quote is older than ${TRADE_QUOTE_MAX_AGE_MS / 1000}s. Re-open it to fetch a fresh route.`,
        );
        onChange(snapshot);
        return snapshot;
      }
      onChange({
        state: "REQUOTING",
        approvalHash: null,
        swapHash: null,
        error: null,
        stepLabel: refreshQuoteLabel(proposal.provider),
      });
      let fresh: TradeProposal;
      try {
        fresh = await input.refreshQuote(proposal);
      } catch {
        const snapshot = fail("PROVIDER_ERROR", refreshQuoteFailedMessage(proposal.provider));
        onChange(snapshot);
        return snapshot;
      }
      if (
        fresh.from.address.toLowerCase() !== proposal.from.address.toLowerCase() ||
        fresh.to.address.toLowerCase() !== proposal.to.address.toLowerCase() ||
        fresh.fromAmount !== proposal.fromAmount ||
        fresh.taker.toLowerCase() !== proposal.taker.toLowerCase() ||
        fresh.slippageBps !== proposal.slippageBps ||
        fresh.provider !== proposal.provider ||
        fresh.transaction?.to.toLowerCase() !== proposal.transaction?.to.toLowerCase()
      ) {
        const snapshot = fail("QUOTE_CHANGED", "The refreshed quote no longer matches this proposal.");
        onChange(snapshot);
        return snapshot;
      }
      if (!fresh.executionAvailable || !fresh.transaction) {
        const snapshot = fail("LIQUIDITY_UNAVAILABLE", "No executable Base route is available for this pair anymore.");
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
      // The refreshed proposal is the one that will actually be signed,
      // so every invariant — including the freshly re-read wallet
      // balance — must hold for it, not just for the quote the user
      // reviewed.
      const revalidatedFresh = revalidateTradeProposal(fresh, account);
      if (revalidatedFresh.state !== "VALIDATED") {
        const snapshot = fail(
          revalidatedFresh.error?.code ?? "INVALID_INPUT",
          revalidatedFresh.error?.message ?? "The refreshed swap is no longer valid.",
        );
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

    // Blocked BEFORE the first signature: no approval gas, no swap gas,
    // nothing broadcast for a swap this wallet cannot fund.
    const fundsError = await checkFundsBeforeBroadcast({ account, proposal });
    if (fundsError) {
      const snapshot = fail(fundsError.code, fundsError.message);
      onChange(snapshot);
      return snapshot;
    }

    // MPGR fee invariant, enforced BEFORE the first wallet prompt. When a
    // proposal claims an applied fee, the transaction about to be signed
    // must provably target the MPGR Executor and commit to exactly the
    // displayed fee inside the swap. Otherwise nothing is signed: this app
    // has no out-of-band way to pay that fee, and must never invent one.
    const feeInvariant = verifyAgentFeeInSwapTransaction(proposal);
    if (!feeInvariant.ok) {
      const snapshot = fail("INVALID_INPUT", feeInvariant.reason);
      onChange(snapshot);
      return snapshot;
    }
    if (feeInvariant.fee) {
      const grossAmountIn = parsePositiveAmount(proposal.fromAmount);
      const inspected = inspectExecutorSwapTransaction({ to: tx.to, data: tx.data });
      const nativeSell = isNativeEthSentinel(proposal.from.address);
      const value = BigInt(tx.value || "0");
      if (
        proposal.permit2 !== null ||
        !inspected.ok ||
        grossAmountIn === null ||
        inspected.value.grossAmountIn !== grossAmountIn ||
        inspected.value.expectedFeeAmount !== feeInvariant.fee.amount ||
        inspected.value.recipient.toLowerCase() !== account.toLowerCase() ||
        value !== (nativeSell ? grossAmountIn : 0n)
      ) {
        const snapshot = fail(
          "INVALID_INPUT",
          "The swap transaction does not match the quoted MPGR fee collected by the Executor — nothing was signed.",
        );
        onChange(snapshot);
        return snapshot;
      }
    }

    if (proposal.needsPermit2Approval && proposal.permit2Spender && !isNativeEthSentinel(proposal.from.address)) {
      // The quote flag was computed when the quote was built. Re-read the
      // allowance for this exact spender on-chain: when it already covers
      // amountIn, another approve() would be a duplicate transaction and a
      // duplicate wallet prompt for the same token/spender/amount. If the
      // read fails, `null` keeps the original approve step (fail-closed).
      const existingAllowance = await readLiveAllowance(
        account,
        proposal.from.address,
        proposal.permit2Spender,
      );
      const required = parsePositiveAmount(proposal.fromAmount);
      const alreadyApproved =
        existingAllowance !== null && required !== null && existingAllowance >= required;

      if (!alreadyApproved) {
        onChange({
          state: "APPROVING",
          approvalHash: null,
          swapHash: null,
          error: null,
          stepLabel: approvalStepLabel(proposal),
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
            const snapshot = fail("APPROVAL_FAILED", approvalFailedMessage(proposal));
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

    // The swap SETTLED. The MPGR fee (0.25%) was already taken by the
    // executor inside this very transaction — nothing else is signed,
    // broadcast or collected here. There is no post-swap fee transfer.
    const success: TradeExecutionSnapshot = {
      state: "SUCCESS",
      approvalHash,
      swapHash,
      error: null,
      stepLabel: "Swap settled on Base.",
    };
    onChange(success);
    return success;
  } catch {
    // Receipt RPC failures are NOT proof of a reverted transaction. Keep the
    // submitted hashes visible and stop here (no further transaction is ever
    // added after the swap, fee or otherwise). Never leave the UI stuck in
    // PENDING or expose a raw provider error.
    const snapshot = {
      ...fail("PROVIDER_ERROR", swapHash
        ? "Swap submitted, but confirmation is unavailable. Its status is unknown. Check BaseScan before retrying."
        : "Could not complete trade preparation. No swap was submitted. Request a fresh quote."),
      approvalHash,
      swapHash,
    };
    onChange(snapshot);
    return snapshot;
  } finally {
    inFlight.delete(key);
  }
}
