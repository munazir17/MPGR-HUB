// lib/swap/swap-executor-config.ts
// Swap-only typed registry for the fixed-fee MPGRSwapExecutor release candidate
// (contracts/swap/MPGRSwapExecutor.sol). Nothing here fetches, signs or deploys.
//
// ACTIVATION STATE: DEPLOYED AND ACTIVE on Base Mainnet. The operator deployed
// MPGRSwapExecutor via the trusted pinned-SHA workflow (see
// docs/PR113-SWAP-EXECUTOR-ACTIVATION.md) and SWAP_PATH_EXECUTOR_DEPLOYMENT
// below pins the sealed, on-chain-verified manifest
// (deployments/base-mainnet/mpgr-swap-executor.json). There is intentionally
// NO env override: an undeclared address can never become executable by
// config drift; disabling routing means reverting the constant to `null`.
// The enum below mirrors MPGRSwapExecutor.RouterKind ONLY; it is separate from
// the deployed MPGRExecutor/Agent RouterKind (whose value 3 is a typed module).
import type { Address } from "viem";
import { UNISWAP_V3_POOL_FEES, type UniswapV3PoolFee } from "@/lib/executor/executor-config";

export const SwapRouterKind = {
  NONE: 0,
  AERODROME_SLIPSTREAM: 1,
  UNISWAP_V3_ROUTER02: 2,
  UNISWAP_V2_ROUTER02: 3,
  AERODROME_CLASSIC: 4,
  PANCAKE_V3: 5,
  ZEROX_SETTLER: 6,
} as const;
export type SwapRouterKindValue = (typeof SwapRouterKind)[keyof typeof SwapRouterKind];
export type SwapVenueKind = Exclude<SwapRouterKindValue, typeof SwapRouterKind.NONE>;

export const SWAP_FEE_BPS = 25 as const;
export const SWAP_FEE_RECIPIENT: Address = "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4";
export const SWAP_MAX_PATH_HOPS = 3 as const;

/** Canonical Base venues the release-candidate executor can be allowlisted for.
 * Registration here is a capability description, never proof of pools/liquidity. */
export const SWAP_PATH_VENUES = {
  uniswapV3: {
    kind: SwapRouterKind.UNISWAP_V3_ROUTER02,
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  },
  slipstream: {
    kind: SwapRouterKind.AERODROME_SLIPSTREAM,
    router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
    factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
    quoter: "0x514c8B5f54112481E28028F1166Bd78501089259",
  },
  uniswapV2: {
    kind: SwapRouterKind.UNISWAP_V2_ROUTER02,
    router: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
    factory: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6",
    quoter: null,
  },
  aerodromeClassic: {
    kind: SwapRouterKind.AERODROME_CLASSIC,
    router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    quoter: null,
  },
  pancakeV3: {
    kind: SwapRouterKind.PANCAKE_V3,
    router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
    factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    quoter: null, // quoted by simulating the typed hop; no trusted quoter pin
  },
} as const satisfies Record<string, { kind: SwapVenueKind; router: Address; factory: Address; quoter: Address | null }>;
export type SwapVenueName = keyof typeof SWAP_PATH_VENUES;

export interface SwapExecutorVenue {
  kind: SwapVenueKind;
  router: Address;
  factory: Address;
  quoter: Address | null;
}
export interface SwapPathExecutorDeployment {
  chainId: 8453;
  executor: Address;
  owner: Address;
  weth: Address;
  permit2: Address;
  deployTx: `0x${string}`;
  deployBlock: number;
  explorerUrl: string;
  venues: readonly SwapExecutorVenue[];
  /** Fee terms verified ON-CHAIN at manifest review time. Tokens are
   * permissionless on-chain, so no token allowlist is part of the manifest. */
  feeBps: number;
  maxFeeBps: number;
  feeTimelockSeconds: number;
  feeRecipient: Address;
  /** Informational only (legacy catalog); never an execution gate. */
  tokens?: readonly Address[];
}

/** Chain-scoped swap configuration. Base is the first (and currently only)
 * release chain; adding a network means adding one entry here plus a
 * deployments/<chain>/ manifest — no cross-chain routing is claimed. */
export const SWAP_CHAIN_REGISTRY = {
  8453: {
    name: "Base",
    venues: SWAP_PATH_VENUES,
    weth: "0x4200000000000000000000000000000000000006" as Address,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    manifest: "deployments/base-mainnet/mpgr-swap-executor.json",
    explorerUrl: "https://basescan.org",
  },
} as const;

/** 0x Swap API v2 (Base): quote source only. Execution goes through the
 * executor's authenticated-settler path, never raw API calldata in the UI. */
export const ZEROX_API_BASE = "https://base.api.0x.org";
export const ZEROX_ALLOWANCE_HOLDER: Address = "0x0000000000001fF3684f28c67538d4D072C22734";
export const ZEROX_SETTLER_DEPLOYER: Address = "0x00000000000004533Fe15556B1E086BB1A72cEae";
export const ZEROX_TAKER_FEATURE_ID = 2n;

/** DEPLOYED on Base Mainnet — every field copied verbatim from the sealed,
 * on-chain-verified deployments/base-mainnet/mpgr-swap-executor.json
 * (deployment tx 0x549a54c2…fa4cc, block 52799525; source verified
 * Exact Match on Basescan; constructor arguments and RouterUpdated events
 * independently re-read from the deployment transaction and cross-checked
 * against SWAP_PATH_VENUES). The owner is the governance SafeL2 1.5.0
 * multisig — never the deployer EOA. Parity with the manifest file is
 * enforced by lib/swap/__tests__/swap-executor-manifest.test.ts. */
/** Fee actually enforced by the deployed executor (manifest-pinned at review
 * time); falls back to the initial policy fee while dormant. */
export const swapPathFeeBps = (deployment: SwapPathExecutorDeployment | null = SWAP_PATH_EXECUTOR_DEPLOYMENT): number =>
  deployment?.feeBps ?? SWAP_FEE_BPS;

export const SWAP_PATH_EXECUTOR_DEPLOYMENT: SwapPathExecutorDeployment | null = {
  chainId: 8453,
  executor: "0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E",
  owner: "0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B", // governance Safe — never the deployer EOA
  weth: "0x4200000000000000000000000000000000000006",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  deployTx: "0x549a54c25a31c0fd47dff625bdfba821c27d892b5cb437473b1decc751efa4cc",
  deployBlock: 52799525,
  explorerUrl: "https://basescan.org",
  venues: [
    { kind: SwapRouterKind.UNISWAP_V3_ROUTER02, router: "0x2626664c2603336E57B271c5C0b26F421741e481", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" },
    { kind: SwapRouterKind.AERODROME_SLIPSTREAM, router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F", factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef", quoter: "0x514c8B5f54112481E28028F1166Bd78501089259" },
    { kind: SwapRouterKind.UNISWAP_V2_ROUTER02, router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", quoter: null },
    { kind: SwapRouterKind.AERODROME_CLASSIC, router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", quoter: null },
    { kind: SwapRouterKind.PANCAKE_V3, router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14", factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", quoter: null },
  ],
  feeBps: 25,
  maxFeeBps: 100,
  feeTimelockSeconds: 172800,
  feeRecipient: "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4",
};

let testDeployment: SwapPathExecutorDeployment | null | undefined;
/** Test-only injection; production always reads the committed manifest. */
export function __setSwapPathExecutorForTests(deployment: SwapPathExecutorDeployment | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Test-only hook.");
  testDeployment = deployment;
}
/** `undefined` = hook untouched (read the committed manifest); an explicit
 * `null` injection must force the dormant state in tests even now that the
 * production constant is non-null. */
export const swapPathExecutor = (): SwapPathExecutorDeployment | null =>
  testDeployment !== undefined ? testDeployment : SWAP_PATH_EXECUTOR_DEPLOYMENT;
export const swapPathVenue = (deployment: SwapPathExecutorDeployment, kind: SwapVenueKind): SwapExecutorVenue | undefined =>
  deployment.venues.find(v => v.kind === kind);
export const swapPathTokenAllowed = (deployment: SwapPathExecutorDeployment, address: string): boolean =>
  (deployment.tokens ?? []).some(t => t.toLowerCase() === address.toLowerCase());
export const swapV3PoolFees: readonly UniswapV3PoolFee[] = UNISWAP_V3_POOL_FEES;
export const SWAP_PATH_EXECUTOR_NOT_DEPLOYED_MESSAGE =
  "These route shapes need the fixed-fee MPGRSwapExecutor contract. Its source and tests are complete, but it is not deployed; activation requires explicit approval. No fee-less fallback exists.";
