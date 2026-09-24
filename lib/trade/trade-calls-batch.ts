// lib/trade/trade-calls-batch.ts
//
// EIP-5792 atomic call batches — the mechanism that collects the MPGR
// Agent fee (0.25%) INSIDE the swap transaction instead of as a third,
// separately-signed transaction.
//
// Why this exists (see docs/TRADE.md "MPGR Agent fee"):
//   The fee is owed in the SELL token to a wallet that is neither the
//   taker nor any spender. The swap calldata is produced by the provider
//   (Coinbase CDP / 0x) or by this app (Aerodrome Slipstream) and none of
//   those calldata targets can forward a slice of the sell amount to a
//   third party — CDP Trade API has no integrator-fee parameter at all.
//   The only way to settle "swap + fee" under one signature, with no new
//   contract and no change to the provider's route or calldata, is an
//   atomic batch of the two calls: [swapCall, feeCall].
//
// Design contract — defensive by construction:
//   - THE SWAP IS NEVER PUT AT RISK BY THE FEE. Every step that can fail
//     (capability detection, the balance the fee leg needs, the batch
//     request itself) degrades to "no fee, plain swap", which is the
//     pre-existing execution path byte-for-byte.
//   - A batch is only ever attempted when the connected wallet ADVERTISES
//     atomic-batch support for Base via `wallet_getCapabilities`, and the
//     caller has separately confirmed the wallet holds sell + fee.
//   - `experimental_fallback` is deliberately NOT used. viem would
//     silently degrade a batch into sequential `eth_sendTransaction`
//     calls (and refuses `forceAtomic` on that path) — i.e. exactly the
//     third transaction this change removes. We require atomicity or
//     nothing.
//   - When a batch IS used, both legs settle or neither does. That is
//     the point of atomicity, and it is why every eligibility check is
//     fail-closed for the fee and fail-open for the swap.
//
// Import-safe: used from the client execution layer. No `server-only`,
// no fetches, no signing, no broadcasting on its own.

import type { Address, Hash } from "viem";
import { getBalance, getCallsStatus, getCapabilities, sendCalls } from "wagmi/actions";

import { config } from "@/lib/wagmi";
import { TRADE_CHAIN_ID } from "./trade-config";

/** Poll cadence while a submitted batch waits for Base. */
export const TRADE_CALLS_POLL_INTERVAL_MS = 1_500;
/** Hard bound so a wedged wallet can never hang the Confirm flow. */
export const TRADE_CALLS_STATUS_TIMEOUT_MS = 120_000;

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

interface CallsBatchTiming {
  pollIntervalMs: number;
  statusTimeoutMs: number;
}

const timing: CallsBatchTiming = {
  pollIntervalMs: TRADE_CALLS_POLL_INTERVAL_MS,
  statusTimeoutMs: TRADE_CALLS_STATUS_TIMEOUT_MS,
};

/**
 * Test hook — shortens the poll cadence/timeout so the "status could not
 * be resolved" branch is reachable without waiting two minutes. Never
 * called from application code.
 */
export function setCallsBatchTimingForTests(next: Partial<CallsBatchTiming>): void {
  timing.pollIntervalMs = next.pollIntervalMs ?? timing.pollIntervalMs;
  timing.statusTimeoutMs = next.statusTimeoutMs ?? timing.statusTimeoutMs;
}

/**
 * Wallet-side rejection strings. Kept identical to the swap's own
 * classifier (trade-execution.ts delegates here) so a cancelled prompt is
 * never mistaken for an unsupported capability.
 */
const REJECTION_PATTERNS = [
  "user rejected",
  "user denied",
  "request rejected",
  "rejected the request",
];

/**
 * Signals that the wallet cannot perform an atomic batch at all — as
 * opposed to a genuine on-chain failure. Only these degrade to the plain
 * swap; anything else is reported as a real send failure.
 */
const BATCH_UNAVAILABLE_NAMES = [
  "AtomicityNotSupportedError",
  "MethodNotFoundRpcError",
  "MethodNotSupportedRpcError",
  "UnsupportedNonOptionalCapabilityError",
];

const BATCH_UNAVAILABLE_PATTERNS = [
  "atomicrequired",
  "atomic",
  "eip-5792",
  "wallet_sendcalls",
  "does not exist / is not available",
  "did not match any variant",
  "not supported",
  "unsupported",
  "method not found",
];

function errorName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return String(err);
  } catch {
    return "";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the user cancelled the wallet prompt. */
export function isWalletRejectionError(err: unknown): boolean {
  const text = `${errorName(err)} ${errorText(err)}`.toLowerCase();
  if (!text.trim()) return false;
  return REJECTION_PATTERNS.some((pattern) => text.includes(pattern));
}

/**
 * True when the wallet simply cannot do an atomic batch. Callers use this
 * to fall back to the plain swap (fee skipped) rather than failing the
 * swap.
 */
function isAtomicBatchUnavailable(err: unknown): boolean {
  const name = errorName(err);
  if (BATCH_UNAVAILABLE_NAMES.includes(name)) return true;
  const text = `${name} ${errorText(err)}`.toLowerCase();
  if (!text.trim()) return false;
  return BATCH_UNAVAILABLE_PATTERNS.some((pattern) => text.includes(pattern));
}

function atomicCapabilitySupported(capability: unknown): boolean {
  if (!capability || typeof capability !== "object") return false;
  const atomic = (capability as Record<string, unknown>).atomic;
  if (!atomic || typeof atomic !== "object") return false;
  return (atomic as Record<string, unknown>).supported === true;
}

/**
 * `wallet_getCapabilities` answers either per chain
 * (`{ "8453": { atomic: { supported: true } } }`) or, when a chainId was
 * requested, directly for that chain (`{ atomic: { supported: true } }`).
 * Both shapes are accepted; anything else is "not supported".
 */
function readAtomicCapability(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const record = capabilities as Record<string, unknown>;
  if (atomicCapabilitySupported(record)) return true;
  const perChain = record[String(TRADE_CHAIN_ID)];
  if (perChain && perChain !== record) return atomicCapabilitySupported(perChain);
  return false;
}

/**
 * Does the connected wallet advertise EIP-5792 ATOMIC batch support on
 * Base? Never throws: a missing method, an RPC blip, or a wallet that
 * does not implement `wallet_getCapabilities` all answer `false`, which
 * means "do not batch" — the safe direction.
 */
export async function supportsAtomicCallBatches(account: Address): Promise<boolean> {
  try {
    const capabilities = await getCapabilities(config, {
      account,
      chainId: TRADE_CHAIN_ID,
    });
    return readAtomicCapability(capabilities);
  } catch {
    return false;
  }
}

export interface AtomicSwapCall {
  to: Address;
  data: `0x${string}`;
  value: bigint;
}

export interface AtomicFeeCall {
  to: Address;
  /** Absent for a native-ETH value transfer. */
  data?: `0x${string}`;
  value: bigint;
}

export interface AtomicSwapBatchInput {
  account: Address;
  swapCall: AtomicSwapCall;
  feeCall: AtomicFeeCall;
}

export type SendAtomicBatchResult =
  | { ok: true; id: string }
  /** The user cancelled the prompt — never retried, and never retried as a swap. */
  | { ok: false; reason: "wallet_rejected" }
  /** The wallet cannot run an atomic batch — the caller falls back to the plain swap. */
  | { ok: false; reason: "batch_unavailable" }
  | { ok: false; reason: "send_failed" };

/**
 * Asks the wallet to execute [swap, fee] as ONE atomic transaction.
 *
 * `forceAtomic` maps to `atomicRequired`, so a compliant wallet either
 * honours atomicity or errors — it cannot silently split the batch into
 * two transactions. No `experimental_fallback` is passed on purpose.
 */
export async function sendAtomicSwapBatch(
  input: AtomicSwapBatchInput,
): Promise<SendAtomicBatchResult> {
  try {
    const { id } = await sendCalls(config, {
      account: input.account,
      chainId: TRADE_CHAIN_ID,
      forceAtomic: true,
      calls: [
        {
          to: input.swapCall.to,
          data: input.swapCall.data,
          value: input.swapCall.value,
        },
        {
          to: input.feeCall.to,
          data: input.feeCall.data,
          value: input.feeCall.value,
        },
      ],
    });
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, reason: "send_failed" };
    }
    return { ok: true, id };
  } catch (err) {
    if (isWalletRejectionError(err)) return { ok: false, reason: "wallet_rejected" };
    if (isAtomicBatchUnavailable(err)) return { ok: false, reason: "batch_unavailable" };
    return { ok: false, reason: "send_failed" };
  }
}

function readReceiptHash(receipt: unknown): Hash | null {
  if (!receipt || typeof receipt !== "object") return null;
  const hash = (receipt as { transactionHash?: unknown }).transactionHash;
  return typeof hash === "string" && HASH_PATTERN.test(hash) ? (hash as Hash) : null;
}

export type AwaitAtomicBatchResult =
  /** Both legs confirmed. `swapHash` is always present in this branch. */
  | { status: "success"; swapHash: Hash; feeHash: Hash | null }
  /** The atomic batch reverted — nothing settled, including the swap. */
  | { status: "failed"; swapHash: Hash | null }
  /**
   * The batch was submitted but its status could not be resolved inside
   * the timeout. Deliberately NOT an error: the swap may well have
   * settled, and the caller must not claim it failed.
   */
  | { status: "unresolved"; batchId: string };

/**
 * Polls `wallet_getCallsStatus` until the batch is terminal.
 *
 * Receipts come back in call order, so receipts[0] is the swap and
 * receipts[1] is the fee. A wallet that reports `atomic: false` after we
 * required `atomicRequired` is a spec violation on its side; both legs
 * are still reported from the receipts it did return.
 */
export async function awaitAtomicSwapBatch(input: {
  id: string;
  /** Test seam — overrides the poll cadence. */
  pollIntervalMs?: number;
  /** Test seam — overrides the timeout. */
  timeoutMs?: number;
}): Promise<AwaitAtomicBatchResult> {
  const interval = input.pollIntervalMs ?? timing.pollIntervalMs;
  const timeout = input.timeoutMs ?? timing.statusTimeoutMs;
  const deadline = Date.now() + timeout;
  let loggedStatusError = false;

  for (;;) {
    let status: Awaited<ReturnType<typeof getCallsStatus>> | null = null;
    try {
      status = await getCallsStatus(config, { id: input.id });
    } catch (err) {
      // Logged once per batch, not once per retry — a wedged wallet must
      // not flood the console while it is being polled.
      if (!loggedStatusError) {
        loggedStatusError = true;
        console.warn(
          "[trade-calls-batch] could not read the batch status; retrying.",
          errorText(err).slice(0, 200),
        );
      }
      status = null;
    }

    if (status) {
      const receipts = Array.isArray(status.receipts) ? status.receipts : [];
      if (status.status === "success" || status.status === "failure") {
        const swapHash = readReceiptHash(receipts[0]);
        const feeHash = readReceiptHash(receipts[1]);
        if (status.status === "success") {
          if (receipts.length === 0) return { status: "unresolved", batchId: input.id };
          if (receipts.every((receipt) => receipt?.status === "success")) {
            // Success, but a wallet that omits a usable hash leaves us
            // unable to prove it — report that honestly rather than
            // claiming a failure the user would act on by retrying.
            return swapHash
              ? { status: "success", swapHash, feeHash }
              : { status: "unresolved", batchId: input.id };
          }
          return { status: "failed", swapHash };
        }
        return { status: "failed", swapHash };
      }
    }

    if (Date.now() >= deadline) {
      return { status: "unresolved", batchId: input.id };
    }
    await delay(interval);
  }
}

/** Live native-ETH balance of the connected wallet on Base. */
export async function readNativeBalance(account: Address): Promise<bigint | null> {
  try {
    const value = await getBalance(config, {
      address: account,
      chainId: TRADE_CHAIN_ID,
    });
    return typeof value === "bigint" ? value : null;
  } catch {
    return null;
  }
}

