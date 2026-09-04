"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ArrowLeftRight, CheckCircle2, Loader2, X } from "lucide-react";

import { formatAddress } from "@/lib/format";
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
  onConfirmAndSwap?: () => void;
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
  onConfirmAndSwap,
}: AgentTradeConfirmationModalProps) {
  if (!proposal) return null;

  const busy = isBusy(confirmationState, executionState);
  const failed = confirmationState === "VALIDATION_FAILED" || executionState === "ERROR";
  const settled = executionState === "SUCCESS";
  const canConfirm =
    confirmationState === "READY_FOR_CONFIRMATION" &&
    executionState === "IDLE" &&
    proposal.executionAvailable;
  const error = executionError ?? confirmationError;

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
            className="w-full max-w-md rounded-t-2xl border border-white/10 bg-zinc-950 p-5 sm:rounded-2xl"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowLeftRight className="h-5 w-5 text-emerald-400" />
                <h2 className="text-sm font-semibold text-white">
                  {proposal.kind === "tokenized-stock-swap" ? "Confirm tokenized-stock swap" : "Confirm swap"}
                </h2>
              </div>
              <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mb-3 text-sm text-zinc-300">{proposal.description}</p>

            <dl className="mb-4 space-y-2 rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">You sell</dt>
                <dd className="text-white">{proposal.displayFromAmount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">You receive (est.)</dt>
                <dd className="text-white">{proposal.displayToAmount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Minimum out</dt>
                <dd className="text-white">{proposal.displayMinToAmount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Network</dt>
                <dd className="text-white">Base</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Slippage</dt>
                <dd className="text-white">{proposal.slippageBps / 100}%</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Route</dt>
                <dd className="text-white">{proposal.providerLabel}</dd>
              </div>
              {proposal.needsPermit2Approval && (
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Steps</dt>
                  <dd className="text-white">Approve Permit2, then swap</dd>
                </div>
              )}
            </dl>

            {proposal.risk.length > 0 && (
              <ul className="mb-4 max-h-32 space-y-1 overflow-y-auto text-[11px] text-amber-300">
                {proposal.risk
                  .filter((fact) => fact.severity !== "info")
                  .map((fact) => (
                    <li key={fact.id}>
                      {fact.title}: {fact.detail}
                    </li>
                  ))}
              </ul>
            )}

            {busy && (
              <div className="mb-4 flex items-center gap-2 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                {stepLabel ?? "Working…"}
              </div>
            )}

            {failed && error && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error.message}</span>
              </div>
            )}

            {settled && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Swap settled
                  {swapHash ? ` — ${formatAddress(swapHash)}` : "."}
                  {approvalHash ? ` Approval ${formatAddress(approvalHash)}.` : ""}
                </span>
              </div>
            )}

            {!settled && (
              <button
                onClick={onConfirmAndSwap}
                disabled={!canConfirm}
                className="w-full rounded-xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                {proposal.executionAvailable ? "Confirm & Swap" : "Execution unavailable"}
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
