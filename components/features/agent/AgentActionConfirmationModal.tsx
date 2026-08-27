"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck, X } from "lucide-react";

import { formatAddress, formatTokenBalance } from "@/lib/format";
import type {
  AgentActionConfirmationError,
  AgentActionConfirmationState,
} from "@/lib/architecture/tools/agent-action-confirmation";
import type { DecodedAgentAction } from "@/lib/architecture/tools/agent-action-simulation";

// P0.5 — Confirmation UI.
//
// Presentational only. All transaction facts displayed here come from
// P0.4's verified DecodedAgentAction. This component never reads or trusts
// action.description, action.data, action.params, or any pre-verification
// transaction fields.
//
// The Confirm button is only a human-confirmation boundary. It never
// executes, signs, or broadcasts a transaction. P0.6 owns execution.

const MPGR_DECIMALS = 18;

interface AgentActionConfirmationModalProps {
  open: boolean;
  onClose: () => void;
  state: AgentActionConfirmationState;
  decoded: DecodedAgentAction | null;
  error: AgentActionConfirmationError | null;
  /** Human-confirmation boundary only — P0.6 will own execution later. */
  onConfirm?: () => void;
}

function isBusy(state: AgentActionConfirmationState): boolean {
  return state === "VERIFYING" || state === "VERIFIED" || state === "SIMULATING";
}

function busyLabel(state: AgentActionConfirmationState): string | null {
  if (state === "VERIFYING" || state === "VERIFIED") return "Verifying...";
  if (state === "SIMULATING") return "Simulating on Base...";
  return null;
}

function isFailed(state: AgentActionConfirmationState): boolean {
  return state === "VERIFICATION_FAILED" || state === "SIMULATION_FAILED";
}

function verificationStatusLabel(state: AgentActionConfirmationState): string {
  if (state === "IDLE" || state === "WALLET_REQUIRED" || state === "VERIFYING") {
    return "Pending";
  }

  if (state === "VERIFICATION_FAILED") {
    return "Failed";
  }

  return "Verified";
}

function simulationStatusLabel(state: AgentActionConfirmationState): string {
  if (
    state === "IDLE" ||
    state === "WALLET_REQUIRED" ||
    state === "VERIFYING" ||
    state === "VERIFIED"
  ) {
    return "Pending";
  }

  if (state === "SIMULATING") {
    return "Simulating...";
  }

  if (state === "SIMULATION_FAILED") {
    return "Failed";
  }

  return "Simulated";
}

function asBigInt(value: unknown): bigint | null {
  return typeof value === "bigint" ? value : null;
}

function asAddressLike(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("0x") ? value : null;
}

function formatMpgr(raw: bigint): string {
  return `${formatTokenBalance(raw, MPGR_DECIMALS)} MPGR`;
}

function formatNativeValue(value: bigint): string {
  if (value === 0n) return "0 ETH";

  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction} ETH` : `${whole} ETH`;
}

// Values displayed here come only from P0.4's decoded calldata.
//
// Argument positions correspond to the calldata P0.4 already decoded and
// verified. This function does not access action.params or independently
// reconstruct transaction truth.
function buildDisplayRows(
  decoded: DecodedAgentAction
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const args = decoded.args;

  if (decoded.domain === "tokenLock") {
    switch (decoded.actionType) {
      case "approve": {
        const spender = asAddressLike(args[0]);
        const amount = asBigInt(args[1]);

        if (spender) {
          rows.push({
            label: "Spender",
            value: formatAddress(spender),
          });
        }

        if (amount !== null) {
          rows.push({
            label: "Amount",
            value: formatMpgr(amount),
          });
        }

        return rows;
      }

      case "createLock": {
        const amount = asBigInt(args[0]);
        const unlockTime = asBigInt(args[1]);

        if (amount !== null) {
          rows.push({
            label: "Amount",
            value: formatMpgr(amount),
          });
        }

        if (unlockTime !== null) {
          rows.push({
            label: "Unlock time",
            value: formatUnixTimestamp(unlockTime),
          });
        }

        return rows;
      }

      case "withdraw":
      case "earlyUnlock": {
        const lockId = asBigInt(args[0]);

        if (lockId !== null) {
          rows.push({
            label: "Lock ID",
            value: lockId.toString(),
          });
        }

        return rows;
      }

      default:
        return rows;
    }
  }

  if (decoded.domain === "staking") {
    switch (decoded.actionType) {
      case "approve": {
        const spender = asAddressLike(args[0]);
        const amount = asBigInt(args[1]);

        if (spender) {
          rows.push({
            label: "Spender",
            value: formatAddress(spender),
          });
        }

        if (amount !== null) {
          rows.push({
            label: "Amount",
            value: formatMpgr(amount),
          });
        }

        return rows;
      }

      case "stake":
      case "unstake": {
        const amount = asBigInt(args[0]);

        if (amount !== null) {
          rows.push({
            label: "Amount",
            value: formatMpgr(amount),
          });
        }

        return rows;
      }

      case "claim":
      case "exit":
        return rows;

      default:
        return rows;
    }
  }

  if (decoded.domain === "rewardVault") {
    switch (decoded.actionType) {
      case "claim": {
        const rewardId = asBigInt(args[0]);

        if (rewardId !== null) {
          rows.push({
            label: "Reward ID",
            value: rewardId.toString(),
          });
        }

        return rows;
      }

      case "claimMultiple": {
        const rewardIds = Array.isArray(args[0])
          ? args[0].filter(
              (value): value is bigint => typeof value === "bigint"
            )
          : [];

        rows.push({
          label: "Reward IDs",
          value:
            rewardIds.length > 0
              ? rewardIds.map((id) => id.toString()).join(", ")
              : "—",
        });

        return rows;
      }

      default:
        return rows;
    }
  }

  return rows;
}

function formatUnixTimestamp(timestamp: bigint): string {
  const milliseconds = Number(timestamp) * 1000;

  if (!Number.isSafeInteger(milliseconds)) {
    return timestamp.toString();
  }

  const date = new Date(milliseconds);

  if (Number.isNaN(date.getTime())) {
    return timestamp.toString();
  }

  return date.toLocaleString();
}

export function AgentActionConfirmationModal({
  open,
  onClose,
  state,
  decoded,
  error,
  onConfirm,
}: AgentActionConfirmationModalProps) {
  const busy = busyLabel(state);
  const failed = isFailed(state);
  const ready = state === "READY_FOR_CONFIRMATION";
  const canClose = !isBusy(state);
  const displayRows = decoded ? buildDisplayRows(decoded) : [];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={canClose ? onClose : undefined}
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:px-4"
        >
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{
              type: "spring",
              stiffness: 260,
              damping: 26,
            }}
            onClick={(event) => event.stopPropagation()}
            className="relative w-full max-w-md rounded-t-2xl border border-white/10 bg-surface p-6 shadow-glow sm:rounded-2xl"
            style={{
              paddingBottom:
                "calc(1.5rem + env(safe-area-inset-bottom))",
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Confirm agent action"
          >
            <button
              type="button"
              onClick={onClose}
              disabled={!canClose}
              aria-label="Close confirmation dialog"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>

            <p className="flex items-center gap-1.5 text-sm font-semibold text-white">
              <ShieldCheck
                className="h-4 w-4 text-primary"
                aria-hidden="true"
              />
              Confirm Action
            </p>

            <p className="mt-1 text-xs text-muted">
              Review exactly what was verified and simulated before confirming.
            </p>

            {state === "WALLET_REQUIRED" && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-muted">
                Connect your wallet to verify and simulate this action.
              </div>
            )}

            {decoded && (
              <div className="mt-4 space-y-2 rounded-xl bg-background/50 p-3.5">
                <Row label="Domain" value={decoded.domain} />
                <Row label="Action type" value={decoded.actionType} />
                <Row
                  label="On-chain function"
                  value={decoded.functionName}
                />
                <Row
                  label="Destination"
                  value={formatAddress(decoded.to)}
                />
                <Row label="Chain" value="Base Mainnet" />
                <Row
                  label="Native value"
                  value={formatNativeValue(decoded.value)}
                  highlight={decoded.value > 0n}
                />

                {displayRows.length > 0 && (
                  <>
                    <div className="my-1 h-px bg-white/10" />

                    {displayRows.map((row, index) => (
                      <Row
                        key={`${row.label}-${index}`}
                        label={row.label}
                        value={row.value}
                      />
                    ))}
                  </>
                )}
              </div>
            )}

            <div className="mt-4 space-y-2 rounded-xl border border-white/[0.08] p-3.5">
              <StatusRow
                label="Verification"
                value={verificationStatusLabel(state)}
                ok={state !== "VERIFICATION_FAILED"}
              />

              <StatusRow
                label="Simulation"
                value={simulationStatusLabel(state)}
                ok={state !== "SIMULATION_FAILED"}
              />

              <StatusRow
                label="Ready to confirm"
                value={ready ? "Yes" : "No"}
                ok={ready}
              />
            </div>

            {failed && error && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                <AlertCircle
                  className="h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{error.message}</span>
              </div>
            )}

            {ready && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
                <CheckCircle2
                  className="h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  Verified and simulated — ready for your confirmation.
                </span>
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                if (ready) {
                  onConfirm?.();
                }
              }}
              disabled={!ready}
              aria-label="Confirm action"
              className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold py-2.5 text-sm font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
            >
              {busy ? (
                <>
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  {busy}
                </>
              ) : (
                "Confirm"
              )}
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted">{label}</span>
      <span
        className={
          highlight
            ? "font-semibold text-gold"
            : "font-semibold text-white"
        }
      >
        {value}
      </span>
    </div>
  );
}

function StatusRow({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted">{label}</span>
      <span
        className={
          ok
            ? "font-semibold text-emerald-400"
            : "font-semibold text-red-400"
        }
      >
        {value}
      </span>
    </div>
  );
}
