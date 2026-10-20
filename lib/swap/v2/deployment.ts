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

export const SWAP_V2_MANIFEST_PATH = "deployments/base-mainnet/mpgr-swap-executor-v2.json";

/** Compile-time pins asserted against the live contract before any quote. */
export const SWAP_V2_CHAIN_ID = 8453 as const;
export const SWAP_V2_GOVERNANCE_SAFE: Address = "0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B";
export const SWAP_V2_MAX_FEE_BPS = 100 as const;
export const SWAP_V2_FEE_TIMELOCK_SECONDS = 172_800 as const; // 48 hours
export const SWAP_V2_WETH: Address = "0x4200000000000000000000000000000000000006";
export const SWAP_V2_PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** Canonical Uniswap v4 PoolManager on Base — the only permitted v4 router,
 * factory and "pool" identity. Verified on-chain before use by preflight. */
export const SWAP_V2_V4_POOL_MANAGER: Address = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
export const SWAP_V2_FLAG_NATIVE_IN = 1 as const;
export const SWAP_V2_FLAG_NATIVE_OUT = 2 as const;

/** RouterKind values the V2 executor can actually execute. Pancake (5) and the
 * 0x Settler (6) are reserved-but-disabled: neither has a passing fork proof,
 * so neither may ever be described as supported. See SWAP_V2_DISABLED_VENUES. */
export const SWAP_V2_ENABLED_KINDS = [1, 2, 3, 4, 7] as const;
export type SwapV2VenueKind = (typeof SWAP_V2_ENABLED_KINDS)[number];
export const SWAP_V2_DISABLED_VENUES: readonly string[] = ["pancakeV3", "zerox"] as const;

export interface SwapV2Venue {
  name: string;
  kind: SwapV2VenueKind;
  router: Address;
  factory: Address;
  quoter: Address | null;
}

export interface SwapV2Verification {
  chainIdAtSeal: number;
  runtimeCodeHash: Hex;
  runtimeCodeSize: number;
  crossCheckedWithSecondRpc: boolean;
  computedCreateAddress: Address;
  deployTxNonce: number;
}

export interface SwapV2ExecutorDeployment {
  chainId: typeof SWAP_V2_CHAIN_ID;
  executor: Address;
  deployer: Address;
  owner: Address;
  weth: Address;
  permit2: Address;
  feeBps: number;
  maxFeeBps: number;
  feeTimelockSeconds: number;
  feeRecipient: Address;
  deployTx: Hex;
  deployBlock: number;
  explorerUrl: string;
  venues: readonly SwapV2Venue[];
  disabledVenues: readonly string[];
  verification: SwapV2Verification;
}

/** Sealed record. Copied verbatim from the committed manifest — never edited
 * here without re-sealing the manifest and re-running the fork proof. */
export const SWAP_V2_SEALED_MANIFEST: SwapV2ExecutorDeployment = {
  chainId: 8453,
  executor: "0x4be1154440b26145d76608D41d403a33e76b9d0A",
  deployer: "0xfDCb6e78217cAf882189e48331a4B42A06309ACA",
  owner: SWAP_V2_GOVERNANCE_SAFE,
  weth: SWAP_V2_WETH,
  permit2: SWAP_V2_PERMIT2,
  feeBps: 25,
  maxFeeBps: SWAP_V2_MAX_FEE_BPS,
  feeTimelockSeconds: SWAP_V2_FEE_TIMELOCK_SECONDS,
  feeRecipient: "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4",
  deployTx: "0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b",
  deployBlock: 52_820_895,
  explorerUrl: "https://basescan.org",
  venues: [
    { name: "uniswapV3", kind: 2, router: "0x2626664c2603336E57B271c5C0b26F421741e481", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" },
    { name: "slipstream", kind: 1, router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F", factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef", quoter: "0x514c8B5f54112481E28028F1166Bd78501089259" },
    { name: "uniswapV2", kind: 3, router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", quoter: null },
    { name: "aerodromeClassic", kind: 4, router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", quoter: null },
    { name: "uniswapV4", kind: 7, router: SWAP_V2_V4_POOL_MANAGER, factory: SWAP_V2_V4_POOL_MANAGER, quoter: null },
  ],
  disabledVenues: SWAP_V2_DISABLED_VENUES,
  verification: {
    chainIdAtSeal: 8453,
    runtimeCodeHash: "0x53896cc37145121436fb4372c6814deb98345261b8ea6e0a6343234dd55e3e39",
    runtimeCodeSize: 21_963,
    crossCheckedWithSecondRpc: true,
    computedCreateAddress: "0x4be1154440b26145d76608D41d403a33e76b9d0A",
    deployTxNonce: 2,
  },
};

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
