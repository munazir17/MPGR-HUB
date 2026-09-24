// lib/trade/trade-execution.ts
//
// P4 — the ONLY module allowed to sign/broadcast a CDP swap.
// Invoked solely from an explicit Confirm click (hooks/useTradeQuote).
//
// Multi-step, matching CDP BYO-wallet docs:
//   1. ERC-20 approve(Permit2) when issues.allowance is set
//   2. Sign Permit2 EIP-712 when quote.permit2 is set
//   3. Append signature to calldata
//   4a. wallet_sendCalls([swap, fee]) — atomic, when the wallet and the
//       funding both allow the MPGR Agent fee to ride along, OR
//   4b. sendTransaction(quote.transaction) — the plain swap, with the fee
//       skipped. Never a separate fee transaction.
//
// The user sees at most two steps — Approval, then Swap — because the
// MPGR Agent fee (0.25%) is NOT a third transaction. It is settled as a
// second call inside the swap transaction via an EIP-5792 atomic batch
// ([swap, fee]), and is skipped entirely when the connected wallet
// cannot do that. See trade-calls-batch.ts for the safety contract.
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
import { buildAgentFeeTransfer, resolveExecutionAgentFee } from "./trade-agent-fee";
import {
  awaitAtomicSwapBatch,
  isWalletRejectionError,
  readNativeBalance,
  sendAtomicSwapBatch,
  supportsAtomicCallBatches,
} from "./trade-calls-batch";
import {
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
  /**
   * MPGR Agent fee (0.25%) settlement. With atomic batching the fee is a
   * second call INSIDE the swap transaction, so `feeHash` is that leg's
   * receipt hash from the same batch — never a separate transaction.
   */
  feeHash: Hash | null;
  feeError: TradeError | null;
  /**
   * Why a quoted fee was not collected. null when the fee was collected
   * or when no fee was ever quoted. Surfaced so a silently uncollected
   * fee is diagnosable instead of invisible.
   */
  feeSkippedReason: string | null;
}

export function idleTradeExecutionSnapshot(): TradeExecutionSnapshot {
  return {
    state: "IDLE",
    approvalHash: null,
    swapHash: null,
    error: null,
    stepLabel: null,
    feeHash: null,
    feeError: null,
    feeSkippedReason: null,
  };
}

function fail(code: TradeError["code"], message: string): TradeExecutionSnapshot {
  return {
    state: "ERROR",
    approvalHash: null,
    swapHash: null,
    error: { code, message },
    stepLabel: null,
    feeHash: null,
    feeError: null,
    feeSkippedReason: null,
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
  if (provider === "aerodrome-slipstream") return "Refreshing Aerodrome quote…";
  if (provider === "0x-swap-api") return "Refreshing 0x quote…";
  return "Refreshing Coinbase CDP quote…";
}

function refreshQuoteFailedMessage(provider: TradeProposal["provider"]): string {
  if (provider === "aerodrome-slipstream") return "Could not refresh the Aerodrome quote.";
  if (provider === "0x-swap-api") return "Could not refresh the 0x quote.";
  return "Could not refresh the Coinbase CDP quote.";
}

function approvalStepLabel(proposal: TradeProposal): string {
  if (proposal.provider === "aerodrome-slipstream") {
    return "Approve Aerodrome SwapRouter in your wallet…";
  }
  if (proposal.provider === "0x-swap-api" && !proposal.permit2) {
    return "Approve 0x AllowanceHolder in your wallet…";
  }
  return "Approve Permit2 in your wallet…";
}

function approvalFailedMessage(proposal: TradeProposal): string {
  if (proposal.provider === "aerodrome-slipstream") {
    return "Aerodrome SwapRouter approval transaction failed on Base.";
  }
  return "Permit2 approval transaction failed on Base.";
}

const inFlight = new Set<string>();

function classifyWalletError(err: unknown, fallback: TradeError["code"]): TradeError {
  if (isWalletRejectionError(err)) {
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

type AtomicAgentFeePlan =
  | { mode: "batch"; recipient: Address; amount: bigint }
  | { mode: "skip"; reason: string };

/**
 * Decides whether the quoted fee can ride along INSIDE the swap
 * transaction. Fail-closed for the fee, fail-open for the swap: every
 * "skip" here means the swap is broadcast exactly as it is today and no
 * fee is collected — never a third transaction.
 *
 * Two gates, both cheap and both non-blocking for the swap:
 *   1. the connected wallet advertises EIP-5792 ATOMIC batch support for
 *      Base (`wallet_getCapabilities`);
 *   2. the wallet holds the sell amount PLUS the fee, because the fee leg
 *      moves sell tokens too. Without this an underfunded fee would
 *      revert the whole atomic batch — the one way batching could hurt
 *      the swap.
 */
async function planAtomicAgentFee(input: {
  account: Address;
  proposal: TradeProposal;
  fee: { send: true; recipient: Address; amount: bigint };
}): Promise<AtomicAgentFeePlan> {
  if (!(await supportsAtomicCallBatches(input.account))) {
    return {
      mode: "skip",
      reason:
        "This wallet does not support atomic batch calls on Base, so the agent fee was not collected.",
    };
  }
  const swapAmount = parsePositiveAmount(input.proposal.fromAmount);
  if (swapAmount === null) {
    return {
      mode: "skip",
      reason: "The swap amount could not be re-read, so the agent fee was not collected.",
    };
  }
  const required = swapAmount + input.fee.amount;
  const balance = isNativeEthSentinel(input.proposal.from.address)
    ? await readNativeBalance(input.account)
    : await readLiveBalance(input.account, input.proposal.from.address);
  if (balance === null || balance < required) {
    return {
      mode: "skip",
      reason:
        "This wallet does not hold the swap amount plus the agent fee, so the fee was not collected.",
    };
  }
  return { mode: "batch", recipient: input.fee.recipient, amount: input.fee.amount };
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
        feeHash: null,
        feeError: null,
        feeSkippedReason: null,
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
        fresh.taker.toLowerCase() !== proposal.taker.toLowerCase()
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
      const revalidatedFresh = revalidateTradeProposal(proposal, account);
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
          feeHash: null,
          feeError: null,
          feeSkippedReason: null,
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
        feeHash: null,
        feeError: null,
        feeSkippedReason: null,
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
      feeHash: null,
      feeError: null,
      feeSkippedReason: null,
    });

    // ------------------------------------------------------------------
    // MPGR Agent fee (0.25%): settled ATOMICALLY with the swap, or not at
    // all. There is deliberately no third transaction and no third wallet
    // prompt. Every branch below either batches the fee into the swap or
    // falls back to the plain swap with the fee skipped.
    // ------------------------------------------------------------------
    const agentFee = resolveExecutionAgentFee(proposal);
    // Only a fee the user actually REVIEWED can be "not collected" in a
    // way worth reporting. No fee was ever quoted → stay silent, exactly
    // as an unconfigured fee wallet behaves today.
    let feeSkippedReason: string | null = null;
    if (proposal.agentFee?.status === "applied" && !agentFee.send) {
      feeSkippedReason = agentFee.reason;
    }
    let batchId: string | null = null;

    if (agentFee.send) {
      const plan = await planAtomicAgentFee({ account, proposal, fee: agentFee });
      if (plan.mode === "batch") {
        const feeTransfer = buildAgentFeeTransfer({
          fromAddress: proposal.from.address,
          recipient: plan.recipient,
          amount: plan.amount,
        });
        const sent = await sendAtomicSwapBatch({
          account,
          swapCall: { to: tx.to, data, value: BigInt(tx.value || "0") },
          feeCall:
            feeTransfer.kind === "native"
              ? { to: feeTransfer.to, value: feeTransfer.value }
              : { to: feeTransfer.to, data: feeTransfer.data, value: 0n },
        });
        if (sent.ok) {
          batchId = sent.id;
        } else if (sent.reason === "wallet_rejected") {
          // Cancelled is final — never retried, never re-prompted.
          const snapshot = fail("WALLET_REJECTED", "The wallet request was cancelled.");
          onChange({ ...snapshot, approvalHash });
          return { ...snapshot, approvalHash };
        } else if (sent.reason === "batch_unavailable") {
          // The wallet advertised atomic batching but could not run it.
          // The swap still has to happen, so the fee is skipped.
          feeSkippedReason =
            "This wallet could not run an atomic batch, so the agent fee was not collected.";
        } else {
          const snapshot = fail("SEND_FAILED", "The wallet could not complete this trade step.");
          onChange({ ...snapshot, approvalHash });
          return { ...snapshot, approvalHash };
        }
      } else {
        feeSkippedReason = plan.reason;
      }
    }

    if (batchId) {
      onChange({
        state: "PENDING",
        approvalHash,
        swapHash: null,
        error: null,
        stepLabel: "Waiting for Base confirmation…",
        feeHash: null,
        feeError: null,
        feeSkippedReason: null,
      });

      const batch = await awaitAtomicSwapBatch({ id: batchId });
      if (batch.status === "failed") {
        // Atomic means atomic: a fee-leg revert reverts the swap too.
        const snapshot = fail("SEND_FAILED", "The swap transaction failed on Base.");
        onChange({ ...snapshot, approvalHash, swapHash: batch.swapHash });
        return { ...snapshot, approvalHash, swapHash: batch.swapHash };
      }
      if (batch.status === "unresolved") {
        // Submitted but unconfirmed. Not an error: the swap may well have
        // settled, and claiming otherwise would be a lie.
        const success: TradeExecutionSnapshot = {
          state: "SUCCESS",
          approvalHash,
          swapHash: null,
          error: null,
          stepLabel: "Swap batch submitted on Base.",
          feeHash: null,
          feeError: {
            code: "SEND_FAILED",
            message:
              "The swap batch was submitted, but its status could not be confirmed yet. " +
              `Check it on Base before trying again (batch ${batch.batchId}).`,
          },
          feeSkippedReason: null,
        };
        onChange(success);
        return success;
      }
      const success: TradeExecutionSnapshot = {
        state: "SUCCESS",
        approvalHash,
        swapHash: batch.swapHash,
        error: null,
        stepLabel: "Swap settled on Base.",
        feeHash: batch.feeHash,
        feeError: null,
        feeSkippedReason: null,
      };
      onChange(success);
      return success;
    }

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
      feeHash: null,
      feeError: null,
      feeSkippedReason: null,
    });

    const receipt = await waitForTransactionReceipt(config, { hash: swapHash });
    if (receipt.status !== "success") {
      const snapshot = fail("SEND_FAILED", "The swap transaction failed on Base.");
      onChange({ ...snapshot, approvalHash, swapHash });
      return { ...snapshot, approvalHash, swapHash };
    }

    // Plain swap path: the fee was not batchable (no atomic-batch support,
    // or the wallet does not hold sell + fee). It is SKIPPED — never sent
    // as a separate transaction, so the user still sees only
    // Approval → Swap.
    const success: TradeExecutionSnapshot = {
      state: "SUCCESS",
      approvalHash,
      swapHash,
      error: null,
      stepLabel: "Swap settled on Base.",
      feeHash: null,
      feeError: null,
      feeSkippedReason,
    };
    onChange(success);
    return success;
  } finally {
    inFlight.delete(key);
  }
}
