// lib/swap/v2/preflight.ts
// Live posture verification for the deployed MPGRSwapExecutorV2.
//
// Read-only. Fails CLOSED: an unreadable or drifted executor is a retryable
// verification failure, never a quote. This is the V2 analogue of V1's
// `verifySwapPathFeeTerms`, extended to the full posture the V2 governance
// model exposes — pause state, fee cap, pinned recipient/owner constants,
// pending (unapplied) fee changes, and every enabled venue's on-chain router
// registration and factory binding.
//
// Nothing here signs, sends, approves or mutates state.
import "server-only";
import type { Address, Hex } from "viem";
import { SWAP_V2_ABI } from "./abi";
import { SWAP_V2_POSTURE_ABI } from "./posture-abi";
import {
  SWAP_V2_CHAIN_ID, SWAP_V2_FEE_TIMELOCK_SECONDS, SWAP_V2_GOVERNANCE_SAFE,
  SWAP_V2_MAX_FEE_BPS, SWAP_V2_V4_POOL_MANAGER,
  type SwapV2ExecutorDeployment,
} from "./deployment";

export class V2PreflightError extends Error {
  constructor(public code: V2PreflightCode, message: string, public status: 422 | 503 = 503) {
    super(message);
    this.name = "V2PreflightError";
  }
}
export type V2PreflightCode =
  | "UNSUPPORTED_NETWORK" | "EXECUTOR_NOT_DEPLOYED" | "EXECUTOR_PAUSED"
  | "FEE_RECIPIENT_CHANGED" | "FEE_POLICY_INVALID" | "OWNER_CHANGED"
  | "PENDING_FEE_CHANGE" | "VENUE_NOT_REGISTERED" | "ROUTE_VERIFICATION_UNAVAILABLE";

export interface V2PreflightReader {
  getChainId(): Promise<number>;
  getCode(args: { address: Address; blockNumber?: bigint }): Promise<Hex | null | undefined>;
  readContract(args: { address: Address; abi: unknown; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
}

export interface V2Posture {
  chainId: number;
  feeBps: number;
  maxFeeBps: number;
  feeRecipient: Address;
  pinnedFeeRecipient: Address;
  owner: Address;
  governanceSafe: Address;
  paused: boolean;
  pendingFeeBps: number;
  pendingFeeRecipient: Address;
  pendingEffectiveAt: bigint;
  feeTimelockSeconds: bigint;
  v4PoolManager: Address;
  blockNumber: bigint;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const read = (reader: V2PreflightReader, executor: Address, abi: unknown, functionName: string, args?: readonly unknown[], blockNumber?: bigint) =>
  reader.readContract({ address: executor, abi, functionName, args, blockNumber });

/** Reads and validates the executor's live posture at `blockNumber`.
 * Throws V2PreflightError; a provider failure is ROUTE_VERIFICATION_UNAVAILABLE
 * (503, retryable) and is never reported as "no liquidity" or "unsupported".
 * `blockTimestamp` is optional; when supplied it lets an already-elapsed pending
 * fee change fail closed instead of merely being surfaced. */
export async function verifyV2Posture(
  reader: V2PreflightReader,
  deployment: SwapV2ExecutorDeployment,
  blockNumber?: bigint,
  blockTimestamp?: bigint,
): Promise<V2Posture> {
  const executor = deployment.executor;
  if (await reader.getChainId() !== SWAP_V2_CHAIN_ID) {
    throw new V2PreflightError("UNSUPPORTED_NETWORK", "Base Mainnet (8453) could not be verified for the V2 executor.");
  }
  const code = await reader.getCode({ address: executor, blockNumber });
  if (!code || code === "0x") {
    throw new V2PreflightError("EXECUTOR_NOT_DEPLOYED", "The sealed V2 executor has no runtime code at the pinned block.", 503);
  }

  let feeBps: unknown, maxFeeBps: unknown, feeRecipient: unknown, owner: unknown, paused: unknown;
  let pendingFeeBps: unknown, pendingFeeRecipient: unknown, pendingEffectiveAt: unknown, timelock: unknown;
  let pinnedRecipient: unknown, safe: unknown, manager: unknown;
  try {
    [feeBps, maxFeeBps, feeRecipient, owner, paused, pendingFeeBps, pendingFeeRecipient, pendingEffectiveAt, timelock, pinnedRecipient, safe, manager] =
      await Promise.all([
        read(reader, executor, SWAP_V2_ABI, "feeBps", undefined, blockNumber),
        read(reader, executor, SWAP_V2_ABI, "MAX_FEE_BPS", undefined, blockNumber),
        read(reader, executor, SWAP_V2_ABI, "feeRecipient", undefined, blockNumber),
        read(reader, executor, SWAP_V2_ABI, "owner", undefined, blockNumber),
        read(reader, executor, SWAP_V2_POSTURE_ABI, "paused", undefined, blockNumber),
        read(reader, executor, SWAP_V2_POSTURE_ABI, "pendingFeeBps", undefined, blockNumber),
        read(reader, executor, SWAP_V2_POSTURE_ABI, "pendingFeeRecipient", undefined, blockNumber),
        read(reader, executor, SWAP_V2_POSTURE_ABI, "pendingEffectiveAt", undefined, blockNumber),
        read(reader, executor, SWAP_V2_POSTURE_ABI, "FEE_TIMELOCK_SECONDS", undefined, blockNumber),
        read(reader, executor, SWAP_V2_POSTURE_ABI, "PINNED_FEE_RECIPIENT", undefined, blockNumber),
        read(reader, executor, SWAP_V2_POSTURE_ABI, "GOVERNANCE_SAFE", undefined, blockNumber),
        read(reader, executor, SWAP_V2_POSTURE_ABI, "V4_POOL_MANAGER", undefined, blockNumber),
      ]);
  } catch {
    throw new V2PreflightError("ROUTE_VERIFICATION_UNAVAILABLE", "The V2 executor's live posture could not be read. No swap was prepared.", 503);
  }

  if (paused !== false) throw new V2PreflightError("EXECUTOR_PAUSED", "The V2 executor is paused on-chain. No swap was prepared.", 503);
  if (Number(maxFeeBps) !== SWAP_V2_MAX_FEE_BPS) throw new V2PreflightError("FEE_POLICY_INVALID", "The V2 executor's on-chain fee cap is not 100 bps.", 422);
  if (BigInt(timelock as bigint) !== BigInt(SWAP_V2_FEE_TIMELOCK_SECONDS)) {
    throw new V2PreflightError("FEE_POLICY_INVALID", "The V2 executor's fee timelock is not 172800 seconds.", 422);
  }
  const bps = Number(feeBps);
  if (!Number.isInteger(bps) || bps < 0 || bps > SWAP_V2_MAX_FEE_BPS) throw new V2PreflightError("FEE_POLICY_INVALID", "The V2 executor's governed fee is out of range.", 422);
  if (bps !== deployment.feeBps) throw new V2PreflightError("FEE_POLICY_INVALID", `The V2 executor's governed fee is ${bps} bps, not the sealed ${deployment.feeBps} bps. Re-review before quoting.`, 422);
  if (typeof feeRecipient !== "string" || !eq(feeRecipient, deployment.feeRecipient) || !eq(pinnedRecipient as string, feeRecipient)) {
    throw new V2PreflightError("FEE_RECIPIENT_CHANGED", "The V2 executor's live fee recipient differs from the pinned treasury. No swap was prepared.", 422);
  }
  if (typeof owner !== "string" || !eq(owner, SWAP_V2_GOVERNANCE_SAFE) || !eq(safe as string, owner)) {
    throw new V2PreflightError("OWNER_CHANGED", "The V2 executor is not owned by the governance Safe. No swap was prepared.", 422);
  }
  // A proposed-but-unapplied fee change is normally not a failure: the app quotes
  // at the CURRENT fee and the timelock guarantees the pending one cannot apply
  // mid-quote. But once that timelock has already elapsed at the pinned block,
  // governance can apply it in any subsequent block, so the sealed 25 bps
  // invariant is no longer guaranteed and quoting must stop.
  const pendingAt = BigInt(pendingEffectiveAt as bigint);
  if (pendingAt !== 0n && blockTimestamp !== undefined && pendingAt <= blockTimestamp) {
    throw new V2PreflightError(
      "PENDING_FEE_CHANGE",
      `A governance fee change to ${Number(pendingFeeBps)} bps passed its timelock at ${pendingAt.toString()} and can be applied at any moment. No swap was prepared.`,
      422,
    );
  }
  if (typeof manager !== "string" || !eq(manager, SWAP_V2_V4_POOL_MANAGER)) {
    throw new V2PreflightError("VENUE_NOT_REGISTERED", "The V2 executor's v4 PoolManager pin does not match canonical Base. No swap was prepared.", 422);
  }

  return {
    chainId: SWAP_V2_CHAIN_ID, feeBps: bps, maxFeeBps: Number(maxFeeBps),
    feeRecipient: feeRecipient as Address, pinnedFeeRecipient: pinnedRecipient as Address,
    owner: owner as Address, governanceSafe: safe as Address, paused: false,
    pendingFeeBps: Number(pendingFeeBps), pendingFeeRecipient: pendingFeeRecipient as Address,
    pendingEffectiveAt: BigInt(pendingEffectiveAt as bigint), feeTimelockSeconds: BigInt(timelock as bigint),
    v4PoolManager: manager as Address, blockNumber: blockNumber ?? 0n,
  };
}

/** Confirms every enabled venue is still registered on-chain with the expected
 * adapter kind and factory binding. A de-registered venue is fail-closed: the
 * executor would revert RouterNotAllowed, so the app must not quote it. */
export async function verifyV2Venues(
  reader: V2PreflightReader,
  deployment: SwapV2ExecutorDeployment,
  blockNumber?: bigint,
): Promise<void> {
  for (const venue of deployment.venues) {
    let kind: unknown, factory: unknown;
    try {
      [kind, factory] = await Promise.all([
        read(reader, deployment.executor, SWAP_V2_ABI, "routerKind", [venue.router], blockNumber),
        read(reader, deployment.executor, SWAP_V2_ABI, "routerFactory", [venue.router], blockNumber),
      ]);
    } catch {
      throw new V2PreflightError("ROUTE_VERIFICATION_UNAVAILABLE", `The ${venue.name} venue registration could not be read. No swap was prepared.`, 503);
    }
    if (Number(kind) !== venue.kind) {
      throw new V2PreflightError("VENUE_NOT_REGISTERED", `The ${venue.name} router is not registered for adapter kind ${venue.kind}. No swap was prepared.`, 422);
    }
    if (typeof factory !== "string" || !eq(factory, venue.factory)) {
      throw new V2PreflightError("VENUE_NOT_REGISTERED", `The ${venue.name} router's on-chain factory differs from the sealed manifest. No swap was prepared.`, 422);
    }
  }
}
