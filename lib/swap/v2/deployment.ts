// lib/swap/v2/deployment.ts
// Typed binding for the sealed MPGRSwapExecutorV2 deployment record.
//
// ACTIVATION STATE: DEPLOYED ON BASE MAINNET, ROUTING **NOT** ACTIVATED.
// `V2_DEPLOYMENT` in ./discovery.ts stays `null`, so `swapV2Executor()` below
// returns `null` and every V2 surface stays inert: /api/swap/v2/quote keeps
// returning `preview: true, executable: false, transaction: null`, and no V2
// transaction can be built, simulated, approved, signed or verified.
//
// Activation is a separate, explicitly approved commit that flips
// `V2_DEPLOYMENT` to `SWAP_V2_SEALED_MANIFEST` below. There is deliberately
// NO env override: an undeclared address can never become executable through
// configuration drift, mirroring the V1 `SWAP_PATH_EXECUTOR_DEPLOYMENT` rule.
//
// Every field of SWAP_V2_SEALED_MANIFEST is copied verbatim from
// deployments/base-mainnet/mpgr-swap-executor-v2.json; parity is enforced by
// lib/swap/v2/deployment.test.ts, which reads the committed manifest file.
import type { Address, Hex } from "viem";
import { V2_DEPLOYMENT } from "./discovery";
import {
  SWAP_V2_CHAIN_ID, SWAP_V2_DISABLED_VENUES, SWAP_V2_ENABLED_KINDS, SWAP_V2_FEE_TIMELOCK_SECONDS,
  SWAP_V2_GOVERNANCE_SAFE, SWAP_V2_MAX_FEE_BPS, SWAP_V2_PERMIT2, SWAP_V2_SEALED_MANIFEST,
  SWAP_V2_V4_POOL_MANAGER, SWAP_V2_WETH,
  type SwapV2ExecutorDeployment, type SwapV2Venue, type SwapV2Verification,
} from "./sealed-manifest";
// Re-exported so every existing importer of "@/lib/swap/v2/deployment" keeps working
// unchanged: the manifest moved module, not name.
export {
  SWAP_V2_CHAIN_ID, SWAP_V2_DISABLED_VENUES, SWAP_V2_ENABLED_KINDS, SWAP_V2_FLAG_NATIVE_IN,
  SWAP_V2_FLAG_NATIVE_OUT, SWAP_V2_FEE_TIMELOCK_SECONDS, SWAP_V2_GOVERNANCE_SAFE, SWAP_V2_MANIFEST_PATH,
  SWAP_V2_MAX_FEE_BPS, SWAP_V2_PERMIT2, SWAP_V2_SEALED_MANIFEST, SWAP_V2_V4_POOL_MANAGER, SWAP_V2_WETH,
  type SwapV2ExecutorDeployment, type SwapV2Venue, type SwapV2VenueKind, type SwapV2Verification,
} from "./sealed-manifest";

let testDeployment: SwapV2ExecutorDeployment | null | undefined;

/** Test-only injection so the activated shape can be exercised without
 * activating production. Mirrors V1's `__setSwapPathExecutorForTests`. */
export function __setSwapV2ExecutorForTests(deployment: SwapV2ExecutorDeployment | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Test-only hook.");
  testDeployment = deployment;
}

/** The single activation gate for every V2 execution surface.
 * Returns `null` (dormant) until `V2_DEPLOYMENT` is flipped by an approved
 * activation commit; an explicit `null` injection forces dormancy in tests. */
export function swapV2Executor(): SwapV2ExecutorDeployment | null {
  const active = testDeployment !== undefined ? testDeployment : (V2_DEPLOYMENT as SwapV2ExecutorDeployment | null);
  return active ?? null;
}

/** True only once routing is genuinely activated. Used by the quote route and
 * by tests that assert the dormant default. */
export const swapV2RoutingActivated = (): boolean => swapV2Executor() !== null;

export const swapV2Venue = (deployment: SwapV2ExecutorDeployment, kind: number): SwapV2Venue | undefined =>
  deployment.venues.find((venue) => venue.kind === kind);

/** Structural validation of a manifest object (used by the parity test and by
 * any future activation review). Never reads the chain. */
export function swapV2DeploymentShapeError(value: unknown): string | null {
  if (!value || typeof value !== "object") return "Manifest is not an object.";
  const d = value as Partial<SwapV2ExecutorDeployment>;
  const address = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
  if (d.chainId !== 8453) return "Manifest chainId must be 8453 (Base Mainnet).";
  for (const key of ["executor", "deployer", "owner", "weth", "permit2", "feeRecipient"] as const) {
    if (!address(d[key])) return `Manifest ${key} is not an address.`;
  }
  if (d.feeBps !== 25) return "Manifest feeBps must be the policy fee 25.";
  if (d.maxFeeBps !== SWAP_V2_MAX_FEE_BPS) return "Manifest maxFeeBps must be 100.";
  if (d.feeTimelockSeconds !== SWAP_V2_FEE_TIMELOCK_SECONDS) return "Manifest feeTimelockSeconds must be 172800.";
  if (d.owner?.toLowerCase() !== SWAP_V2_GOVERNANCE_SAFE.toLowerCase()) return "Manifest owner must be the governance Safe, never the deployer EOA.";
  if (d.feeRecipient?.toLowerCase() !== "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4".toLowerCase()) return "Manifest feeRecipient must be the pinned treasury.";
  if (d.weth?.toLowerCase() !== SWAP_V2_WETH.toLowerCase()) return "Manifest weth must be canonical Base WETH.";
  if (d.permit2?.toLowerCase() !== SWAP_V2_PERMIT2.toLowerCase()) return "Manifest permit2 must be canonical Permit2.";
  if (typeof d.deployTx !== "string" || !/^0x[0-9a-f]{64}$/i.test(d.deployTx)) return "Manifest deployTx is not a transaction hash.";
  if (!Number.isInteger(d.deployBlock) || (d.deployBlock as number) <= 0) return "Manifest deployBlock is not a positive integer.";
  if (!Array.isArray(d.venues) || d.venues.length === 0) return "Manifest venues must be a non-empty list.";
  // A manifest may never advertise a venue that has no passing fork proof. This
  // check runs first so the reason names the venue rather than its kind.
  const names = new Set((d.venues as readonly SwapV2Venue[]).map((v) => v.name.toLowerCase()));
  for (const disabled of SWAP_V2_DISABLED_VENUES) {
    if (names.has(disabled.toLowerCase())) return `Manifest must not enable disabled venue ${disabled}.`;
  }
  for (const venue of d.venues as readonly SwapV2Venue[]) {
    if (!SWAP_V2_ENABLED_KINDS.includes(venue.kind)) return `Manifest venue ${venue.name} has a disabled or unknown kind.`;
    if (!address(venue.router) || !address(venue.factory)) return `Manifest venue ${venue.name} has an invalid router/factory.`;
    if (venue.kind === 7 && (venue.router.toLowerCase() !== SWAP_V2_V4_POOL_MANAGER.toLowerCase() || venue.factory.toLowerCase() !== SWAP_V2_V4_POOL_MANAGER.toLowerCase())) {
      return "Manifest v4 venue must point router and factory at the canonical PoolManager.";
    }
  }
  const verification = d.verification as Partial<SwapV2Verification> | undefined;
  if (!verification || typeof verification.runtimeCodeHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(verification.runtimeCodeHash)) {
    return "Manifest verification.runtimeCodeHash is missing or malformed.";
  }
  if (!Number.isInteger(verification.runtimeCodeSize) || (verification.runtimeCodeSize as number) <= 0) return "Manifest verification.runtimeCodeSize is not a positive integer.";
  if (verification.crossCheckedWithSecondRpc !== true) return "Manifest must record an independent second-RPC cross-check.";
  if (!address(verification.computedCreateAddress)) return "Manifest verification.computedCreateAddress is not an address.";
  if (verification.computedCreateAddress?.toLowerCase() !== d.executor?.toLowerCase()) return "Manifest CREATE-derived address must equal the executor address.";
  return null;
}
