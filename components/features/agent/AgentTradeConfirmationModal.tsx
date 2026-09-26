"use client";

import { useId } from "react";
import { BASE_USDC, BASE_WETH } from "@/lib/trade/trade-config";

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ArrowLeftRight, CheckCircle2, Loader2, X } from "lucide-react";

import { formatAddress } from "@/lib/format";
import { formatAtomicAmount } from "@/lib/trade/trade-format";
import { findKnownTradeToken } from "@/lib/trade/trade-tokens";
import type { TradeConfirmationState } from "@/lib/trade/trade-confirmation";
import type { TradeExecutionState } from "@/lib/trade/trade-execution";
import type { TradeError, TradeProposal } from "@/lib/trade/trade-types";

interface AgentTradeConfirmationModalProps {
  open: boolean;
  onClose: () => void;
  proposal: TradeProposal | null;
  confirmationState: TradeConfirmationState;
  confirmationError: TradeError | null;
  executionState: TradeExecutionState;
  executionError: TradeError | null;
  approvalHash: `0x${string}` | null;
  swapHash: `0x${string}` | null;
  stepLabel: string | null;
  feeHash?: `0x${string}` | null;
  feeError?: TradeError | null;
  onConfirmAndSwap?: () => void;
}

/**
 * Fee rows from the quote itself (CDP gas + protocol fee, or the 0x gas
 * fee). Amounts arrive as atomic-unit strings; they are rendered with the
 * fee token's real decimals when that token is in the app's catalog, and
 * otherwise shown with the atomic value labelled as such — never
 * re-scaled by a guessed decimals value.
 */
function feeRows(fees: TradeProposal["fees"]): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, fee: { amount: string; token: string } | undefined | null) => {
    if (!fee || !fee.amount) return;
    const known = findKnownTradeToken(fee.token);
    const amount = known
      ? `${formatAtomicAmount(fee.amount, known.decimals)} ${known.symbol}`
      : `${fee.amount} ${fee.token || "atomic units"}`;
    rows.push({ label, value: amount });
  };
  push("Protocol fee", fees.protocolFee);
  push("Est. gas fee", fees.gasFee);
  return rows;
}

function formatPriceImpact(bps: number | null | undefined): string | null {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return null;
  const sign = bps > 0 ? "+" : "";
  return `${sign}${(bps / 100).toFixed(2)}%`;
}

function isBusy(confirmationState: TradeConfirmationState, executionState: TradeExecutionState): boolean {
  return (
    confirmationState === "VALIDATING" ||
    executionState === "REQUOTING" ||
    executionState === "APPROVING" ||
    executionState === "AWAITING_PERMIT" ||
    executionState === "AWAITING_WALLET" ||
    executionState === "PENDING"
  );
}

export function AgentTradeConfirmationModal({
  open,
  onClose,
  proposal,
  confirmationState,
  confirmationError,
  executionState,
  executionError,
  approvalHash,
  swapHash,
  stepLabel,
  feeHash,
  feeError,
  onConfirmAndSwap,
}: AgentTradeConfirmationModalProps) {
  const titleId = useId();
  if (!proposal) return null;

  const busy = isBusy(confirmationState, executionState);
  const failed = confirmationState === "VALIDATION_FAILED" || executionState === "ERROR";
  const settled = executionState === "SUCCESS";
  const canConfirm =
    confirmationState === "READY_FOR_CONFIRMATION" &&
    executionState === "IDLE" &&
    proposal.executionAvailable;
  const error = executionError ?? confirmationError;
  const progress = settled ? 5
    : executionState === "PENDING" ? 4
    : executionState === "AWAITING_WALLET" || executionState === "AWAITING_PERMIT" ? 3
    : executionState === "APPROVING" ? 2
    : executionState === "REQUOTING" || confirmationState === "VALIDATING" ? 0 : 1;
  const stages = ["Quote", "Prepare", "Approval (if needed)", "User signature", "Executing", "Confirmed"];
  const isExecutorPair = [proposal.from.address.toLowerCase(), proposal.to.address.toLowerCase()].sort().join(":") ===
    [BASE_USDC.toLowerCase(), BASE_WETH.toLowerCase()].sort().join(":");
  const impact = formatPriceImpact(proposal.priceImpactBps);
  const fees = feeRows(proposal.fees);
  // Compact risk display: safety-critical facts keep their full detail;
  // warnings show as one-line titles (no long technical paragraphs).
  const criticalRisk = proposal.risk.filter((fact) => fact.severity === "critical");
  const warningRisk = proposal.risk.filter((fact) => fact.severity === "warning");

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-busy={busy}
            className="max-h-[90dvh] w-full max-w-[440px] overflow-y-auto overscroll-contain rounded-t-3xl border border-white/[0.08] bg-surface bg-gradient-surface p-6 shadow-glow-lg sm:rounded-3xl sm:p-8"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowLeftRight className="h-5 w-5 text-good" />
                <h2 id={titleId} className="text-sm font-semibold text-white">
                  {proposal.kind === "tokenized-stock-swap" ? "Confirm tokenized-stock swap" : "Confirm swap"}
                </h2>
              </div>
              <button type="button" onClick={onClose} disabled={busy} className="flex h-11 w-11 shrink-0 items-center justify-center text-zinc-400 hover:text-white disabled:opacity-40" aria-label="Close" title={busy ? "Keep this progress visible until the wallet operation finishes" : "Close"}>
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mb-3 text-sm text-zinc-300">{proposal.description}</p>

            <p className="mb-3 text-xs text-zinc-400">Your wallet signs and sends. MPGR never signs for you or controls your wallet.</p>
            <ol aria-label="Trade progress" className="mb-4 grid grid-cols-3 gap-2 text-[10px]">
              {stages.map((stage, index) => (
                <li key={stage} aria-current={!failed && index === progress ? "step" : undefined}
                  className={`rounded-lg border p-2 ${!failed && index === progress ? "border-primary/40 text-primary-glow" : "border-white/10 text-zinc-400"}`}>
                  {stage}
                </li>
              ))}
            </ol>

            <dl className="mb-4 space-y-2 rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">You sell</dt>
                <dd className="min-w-0 break-words text-right text-white">{formatAtomicAmount(proposal.fromAmount, proposal.from.decimals, proposal.from.decimals)} {proposal.from.symbol}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">You receive (est.)</dt>
                <dd className="min-w-0 break-words text-right text-white">{formatAtomicAmount(proposal.toAmount, proposal.to.decimals, proposal.to.decimals)} {proposal.to.symbol}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Minimum out</dt>
                <dd className="min-w-0 break-words text-right text-white">{formatAtomicAmount(proposal.minToAmount, proposal.to.decimals, proposal.to.decimals)} {proposal.to.symbol}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Network</dt>
                <dd className="min-w-0 break-words text-right text-white">Base</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Slippage</dt>
                <dd className="min-w-0 break-words text-right text-white">{proposal.slippageBps / 100}%</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">This quote’s route</dt>
                <dd className="min-w-0 break-words text-right text-white">{proposal.providerLabel}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Price impact</dt>
                <dd
                  className={
                    impact === null
                      ? "text-zinc-500"
                      : (proposal.priceImpactBps ?? 0) < 0
                        ? "text-amber-300"
                        : "text-good"
                  }
                >
                  {impact ?? "not reported"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Recipient / wallet</dt>
                <dd className="min-w-0 break-all text-right font-mono text-white" title={proposal.taker}>{proposal.taker}</dd>
              </div>
              {proposal.permit2Spender && (
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Approval spender</dt>
                  <dd className="min-w-0 break-all text-right font-mono text-white">{proposal.permit2Spender}</dd>
                </div>
              )}
              {fees.map((fee) => (
                <div key={fee.label} className="flex justify-between gap-3">
                  <dt className="text-zinc-500">{fee.label}</dt>
                  <dd className="min-w-0 break-words text-right text-white">{fee.value}</dd>
                </div>
              ))}
              {proposal.agentFee?.status === "applied" && proposal.agentFee.displayAmount && (
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">MPGR fee · 25 bps (0.25%)</dt>
                  <dd className="min-w-0 break-words text-right text-white">{formatAtomicAmount(proposal.agentFee.amountAtomic, proposal.from.decimals, proposal.from.decimals)} {proposal.from.symbol} (separate tx)</dd>
                </div>
              )}
              {proposal.agentFee?.status === "skipped" && (
                <div className="text-amber-300"><dt>MPGR fee not applied</dt><dd>{proposal.agentFee.reason ?? "Unavailable"}. No fee transfer is prepared.</dd></div>
              )}
            </dl>
            {proposal.agentFee?.status === "applied" && (
              <p className="mb-3 text-[11px] text-zinc-400">For this in-app route, the fee is an additional sell-token transfer after the swap, with a separate wallet confirmation. It is not deducted from the amount above.</p>
            )}
            {isExecutorPair && (
              <p className="mb-4 rounded-lg border border-white/10 p-3 text-[11px] text-zinc-400">
                Separate MCP flow: MPGR Executor uses Uniswap V3 on Base for USDC ↔ WETH (pool fee 3000 / 0.30%), with the 25 bps fee deducted from the sell amount in the same transaction. This in-app quote uses the route shown above, not the MCP Executor.
              </p>
            )}

            {(criticalRisk.length > 0 || warningRisk.length > 0) && (
              <ul className="mb-4 max-h-32 space-y-1 overflow-y-auto text-[11px] text-amber-300">
                {criticalRisk.map((fact) => (
                  <li key={fact.id}>
                    {fact.title}: {fact.detail}
                  </li>
                ))}
                {warningRisk.map((fact) => (
                  <li key={fact.id}>{fact.title}</li>
                ))}
              </ul>
            )}

            {busy && (
              <div role="status" aria-live="polite" className="mb-4 flex items-center gap-2 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                {stepLabel ?? (confirmationState === "VALIDATING" ? "Checking quote and wallet…" : `${stages[progress]}…`)}
              </div>
            )}

            {failed && error && (
              <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-bad/30 bg-bad/10 p-3 text-sm text-bad">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error.message}</span>
              </div>
            )}

            {settled && (
              <div role="status" className="mb-4 flex items-start gap-2 rounded-lg border border-good/30 bg-good/10 p-3 text-sm text-good">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Swap confirmed on Base
                  {swapHash ? ` — ${formatAddress(swapHash)}` : "."}
                  {approvalHash ? ` Approval ${formatAddress(approvalHash)}.` : ""}
                  {feeHash ? ` Agent fee ${formatAddress(feeHash)}.` : ""}
                </span>
              </div>
            )}

            {settled && feeError && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{feeError.message}</span>
              </div>
            )}

            {(approvalHash || swapHash || feeHash) && (
              <div className="mb-4 flex flex-wrap gap-3 text-xs">
                {([["Approval", approvalHash], ["Swap", swapHash], ["Fee", feeHash]] as const).map(([label, hash]) => hash && (
                  <a key={label} href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noopener noreferrer" className="text-primary-glow underline">View {label.toLowerCase()} on BaseScan</a>
                ))}
              </div>
            )}
            {failed && <p className="mb-3 text-xs text-zinc-400">Close and request a fresh quote to try again. Check any submitted transaction above before retrying.</p>}

            {!settled && (
              <button
                onClick={onConfirmAndSwap}
                disabled={!canConfirm}
                className="btn-primary w-full text-sm"
              >
                {busy ? "Awaiting your wallet / confirmation…" : failed ? "Request a fresh quote" : proposal.executionAvailable ? "Confirm & Swap" : "Execution unavailable"}
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
