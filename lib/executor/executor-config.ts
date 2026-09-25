// lib/executor/executor-config.ts
//
// Typed, compile-time registry of MPGR Executor deployments.
//
// Rules (AGENTS.md): typed chain config, no secrets, bigint math, no
// NEXT_PUBLIC secrets. Nothing here fetches or signs.
//
// Filling a registry entry records a DEPLOYED fact only; it does not switch
// trading on. Base mainnet MCP trading stays OFF until the operator sets
// MPGR_MCP_ENABLE_BASE_MAINNET=true (see lib/mcp/mcp-deps.ts).
//
// Base Sepolia (84532) is mirrored from
// deployments/base-sepolia/mpgr-executor.json after the label-triggered
// GitHub Actions deployment (.github/workflows/deploy-executor-base-sepolia.yml).
// Base mainnet (8453) is mirrored from
// deployments/base-mainnet/mpgr-executor.json (one-time deployment, workflow
// run 36110098967). Only routes that are actually proven are registered:
// USDC <-> WETH on the OFFICIAL Base Uniswap V3 deployment (SwapRouter02 +
// QuoterV2, 0.30% pool). That is the route migrated FROM the app's Aerodrome
// Slipstream venue, whose only recorded evidence was the CI Base-mainnet FORK
// suite and a scripted smoke run — never a confirmed live mainnet trade. The
// contract also allowlists the B20 tokenized stocks, but no USDC<->B20 swap
// through the executor has ever been executed, so B20 tokens/routes are
// deliberately NOT registered here and are never routed through the executor
// by MCP.

import type { Address } from "viem";

export const BASE_MAINNET_CHAIN_ID = 8453 as const;
export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;
export type ExecutorChainId = typeof BASE_MAINNET_CHAIN_ID | typeof BASE_SEPOLIA_CHAIN_ID;

/** Mirrors `MPGRExecutor.RouterKind` (uint8). Order MUST match the contract enum. */
export const RouterKind = {
  NONE: 0,
  AERODROME_SLIPSTREAM: 1,
  UNISWAP_V3_ROUTER02: 2,
} as const;
export type RouterKindValue = (typeof RouterKind)[keyof typeof RouterKind];

/** Mirrors `MPGRExecutor.AuthKind` (uint8). */
export const AuthKind = {
  APPROVAL: 0,
  EIP2612: 1,
  PERMIT2: 2,
} as const;
export type AuthKindValue = (typeof AuthKind)[keyof typeof AuthKind];
export type AuthorizationMode = keyof typeof AuthKind;

/** Mirrors contract constants. */
export const EXECUTOR_BPS_DENOMINATOR = 10_000n;
export const EXECUTOR_MAX_FEE_BPS = 100;
/** Product fee policy: 25 bps of the SELL amount (owner-configurable ≤ cap). */
export const EXECUTOR_DEFAULT_FEE_BPS = 25;
/** Uniswap V3 fee tiers accepted by `swapUniswapV3ExactInputSingle`. */
export const UNISWAP_V3_POOL_FEES = [100, 500, 3000, 10000] as const;
export type UniswapV3PoolFee = (typeof UNISWAP_V3_POOL_FEES)[number];

export interface ExecutorToken {
  address: Address;
  symbol: string;
  decimals: number;
  /** True for the chain's WETH (enables native-ETH in/out through the executor). */
  isWeth?: boolean;
  /** Testnet-only token deployed by the MPGR deploy script. */
  testnet?: boolean;
}

export interface ExecutorRoute {
  /** Which typed adapter the executor calls. */
  kind: Exclude<RouterKindValue, typeof RouterKind.NONE>;
  router: Address;
  quoter: Address;
  /** Pool key: Uniswap V3 fee tier or Slipstream tickSpacing. */
  poolFee?: UniswapV3PoolFee;
  tickSpacing?: number;
  tokenA: Address;
  tokenB: Address;
}

export interface ExecutorDeployment {
  chainId: ExecutorChainId;
  network: "base" | "base-sepolia";
  executor: Address;
  owner: Address;
  feeRecipient: Address;
  feeBps: number;
  weth: Address;
  permit2: Address;
  deployTx: `0x${string}`;
  deployBlock: number;
  explorerUrl: string;
  tokens: readonly ExecutorToken[];
  routes: readonly ExecutorRoute[];
}

export const CANONICAL_WETH: Address = "0x4200000000000000000000000000000000000006";
export const CANONICAL_PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Uniswap V3 on Base Sepolia (official deployments page). */
export const BASE_SEPOLIA_UNISWAP_V3 = {
  factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  quoterV2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
  swapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
  positionManager: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
} as const satisfies Record<string, Address>;

/** Test tokens created by the Base Sepolia deploy script (no mint function; supply held by the deployer). */
export const BASE_SEPOLIA_TUSD: Address = "0xc5C9F70A7F3EB18FC33406275Bffe31a922fcde5";
export const BASE_SEPOLIA_TSTOCK: Address = "0x9102c5B535d25A9265e2793174701BdaCeEAAfC4";

/**
 * MPGR Executor on Base Sepolia — deployed by the `Deploy MPGR Executor (Base Sepolia)`
 * workflow (run 36067982010). Mirrors deployments/base-sepolia/mpgr-executor.json field for
 * field (enforced by lib/executor/__tests__/executor-registry.test.ts) and is re-verified
 * against the live chain — bytecode, owner, fee recipient, fee, router, tokens — by
 * test/fork/MPGRExecutorBaseSepoliaDeployment.t.sol in the `contracts-fork` CI job.
 */
export const BASE_SEPOLIA_EXECUTOR_DEPLOYMENT: ExecutorDeployment = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  network: "base-sepolia",
  executor: "0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4",
  owner: "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e",
  feeRecipient: "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4",
  feeBps: EXECUTOR_DEFAULT_FEE_BPS,
  weth: CANONICAL_WETH,
  permit2: CANONICAL_PERMIT2,
  deployTx: "0xcfba1186b37aec5022621cabf3eebb3a0acfeffc059847bb0befe9954378831d",
  deployBlock: 47262106,
  explorerUrl: "https://sepolia.basescan.org/address/0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4",
  tokens: [
    { address: CANONICAL_WETH, symbol: "WETH", decimals: 18, isWeth: true },
    { address: BASE_SEPOLIA_TUSD, symbol: "tUSD", decimals: 6, testnet: true },
    { address: BASE_SEPOLIA_TSTOCK, symbol: "tSTOCK", decimals: 18, testnet: true },
  ],
  routes: [
    {
      kind: RouterKind.UNISWAP_V3_ROUTER02,
      router: BASE_SEPOLIA_UNISWAP_V3.swapRouter02,
      quoter: BASE_SEPOLIA_UNISWAP_V3.quoterV2,
      poolFee: 3000,
      tokenA: BASE_SEPOLIA_TUSD,
      tokenB: BASE_SEPOLIA_TSTOCK,
    },
    {
      kind: RouterKind.UNISWAP_V3_ROUTER02,
      router: BASE_SEPOLIA_UNISWAP_V3.swapRouter02,
      quoter: BASE_SEPOLIA_UNISWAP_V3.quoterV2,
      poolFee: 3000,
      tokenA: CANONICAL_WETH,
      tokenB: BASE_SEPOLIA_TUSD,
    },
  ],
};

/**
 * MPGR Executor on Base Mainnet — one-time deployment by workflow run
 * 36110098967 (see deployments/base-mainnet/mpgr-executor.json). Mirrors the
 * committed record field for field (enforced by
 * lib/executor/__tests__/executor-registry.test.ts) and is re-verified against
 * the live chain by test/fork/MPGRExecutorBaseMainnetDeployment.t.sol in the
 * `contracts-fork` CI job (bytecode == repo source, owner, fee recipient,
 * fee, cap, router kind, token allowlist).
 *
 * `tokens`/`routes` are the MCP-routable subset: only USDC and WETH, and only
 * the official Base Uniswap V3 WETH/USDC 0.30% pool (fee 3000, pool
 * 0x6c561B446416E1A00E8E93E221854d6eA4171372, CREATE2-derived from the
 * Uniswap V3 factory). The contract's B20 tokenized stock allowlist is
 * intentionally excluded — no USDC<->B20 swap through the executor has been
 * executed, so the executor must not be advertised or routed for those pairs
 * (they stay on the app UI's CDP path; over MCP they fall through to the 0x
 * path like any other non-executor pair).
 *
 * MIGRATION NOTE (no redeploy, no owner transaction): this entry is the
 * app-side route registry. The live contract still has the Aerodrome
 * Slipstream router allowlisted (kind 1) until the owner executes
 * `setRouter(0x2626664c…e481, 2)`. `script/prepare-uniswap-v3-allowlist.mjs`
 * prints — never sends — that transaction. Until it is executed, mainnet MCP
 * trading stays gated off by MPGR_MCP_ENABLE_BASE_MAINNET anyway.
 */
export const BASE_MAINNET_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Uniswap V3 on Base Mainnet — the official v3 deployment (Uniswap deployments list; all
 *  three contracts are Basescan-verified). This is the executor's production venue for
 *  USDC <-> WETH; the pool is derived from the factory with CREATE2 (see
 *  lib/executor/uniswap-v3-pool.ts) and asserted by
 *  lib/executor/__tests__/uniswap-v3-mainnet-route.test.ts. */
export const BASE_MAINNET_UNISWAP_V3 = {
  factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
} as const satisfies Record<string, Address>;

/** The Uniswap V3 fee tier used for the production USDC <-> WETH route (0.30%). */
export const BASE_MAINNET_USDC_WETH_POOL_FEE = 3000;
/** The official Base Uniswap V3 WETH/USDC 0.30% pool (CREATE2-derived from the factory above). */
export const BASE_MAINNET_USDC_WETH_POOL: Address = "0x6c561B446416E1A00E8E93E221854d6eA4171372";

/** Aerodrome Slipstream on Base Mainnet (Gauges V3): the app UI's B20 tokenized-stock venue
 *  (lib/trade/trade-config.ts) and the executor's PREVIOUS mainnet route. It is no longer
 *  registered as an executor route: the migrate-to-Uniswap-V3 change pointed the registry at
 *  the official Base Uniswap V3 0.30% pool instead. Kept here as the documented pre-migration
 *  value; no executor route below references it. */
export const BASE_MAINNET_SLIPSTREAM = {
  factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  quoterV2: "0x514c8B5f54112481E28028F1166Bd78501089259",
  swapRouter: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
} as const satisfies Record<string, Address>;

export const BASE_MAINNET_EXECUTOR_DEPLOYMENT: ExecutorDeployment = {
  chainId: BASE_MAINNET_CHAIN_ID,
  network: "base",
  executor: "0xD982726e28275661F8aB64054E6b17a70a63505A",
  owner: "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e",
  feeRecipient: "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4",
  feeBps: EXECUTOR_DEFAULT_FEE_BPS,
  weth: CANONICAL_WETH,
  permit2: CANONICAL_PERMIT2,
  deployTx: "0xf17fcaef66a8a67153114a8a14b7813ffaa7ec2877eb5e9e35171467aa999d01",
  deployBlock: 51767139,
  explorerUrl: "https://basescan.org/address/0xD982726e28275661F8aB64054E6b17a70a63505A",
  tokens: [
    { address: BASE_MAINNET_USDC, symbol: "USDC", decimals: 6 },
    { address: CANONICAL_WETH, symbol: "WETH", decimals: 18, isWeth: true },
  ],
  routes: [
    {
      kind: RouterKind.UNISWAP_V3_ROUTER02,
      router: BASE_MAINNET_UNISWAP_V3.swapRouter02,
      quoter: BASE_MAINNET_UNISWAP_V3.quoterV2,
      poolFee: BASE_MAINNET_USDC_WETH_POOL_FEE,
      tokenA: BASE_MAINNET_USDC,
      tokenB: CANONICAL_WETH,
    },
  ],
};

/**
 * Deployment registry (deployed facts only — NOT a trading switch; MCP mainnet
 * trading is gated by MPGR_MCP_ENABLE_BASE_MAINNET in lib/mcp/mcp-deps.ts).
 * - 8453: the Base Mainnet deployment above.
 * - 84532: the Base Sepolia deployment above.
 */
export const MPGR_EXECUTOR_DEPLOYMENTS: Record<ExecutorChainId, ExecutorDeployment | null> = {
  [BASE_MAINNET_CHAIN_ID]: BASE_MAINNET_EXECUTOR_DEPLOYMENT,
  [BASE_SEPOLIA_CHAIN_ID]: BASE_SEPOLIA_EXECUTOR_DEPLOYMENT,
};

export const EXECUTOR_CHAIN_NAMES: Record<ExecutorChainId, string> = {
  [BASE_MAINNET_CHAIN_ID]: "Base",
  [BASE_SEPOLIA_CHAIN_ID]: "Base Sepolia",
};

export const EXECUTOR_EXPLORERS: Record<ExecutorChainId, string> = {
  [BASE_MAINNET_CHAIN_ID]: "https://basescan.org",
  [BASE_SEPOLIA_CHAIN_ID]: "https://sepolia.basescan.org",
};

export function isExecutorChainId(value: unknown): value is ExecutorChainId {
  return value === BASE_MAINNET_CHAIN_ID || value === BASE_SEPOLIA_CHAIN_ID;
}

export function getExecutorDeployment(
  chainId: ExecutorChainId,
  registry: Record<ExecutorChainId, ExecutorDeployment | null> = MPGR_EXECUTOR_DEPLOYMENTS,
): ExecutorDeployment | null {
  return registry[chainId] ?? null;
}

export function findExecutorToken(deployment: ExecutorDeployment, address: string): ExecutorToken | null {
  const needle = address.toLowerCase();
  return deployment.tokens.find((t) => t.address.toLowerCase() === needle) ?? null;
}

/** Routes are unordered pairs; returns the first route covering {tokenIn, tokenOut}. */
export function findExecutorRoute(
  deployment: ExecutorDeployment,
  tokenIn: string,
  tokenOut: string,
): ExecutorRoute | null {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  return (
    deployment.routes.find((r) => {
      const x = r.tokenA.toLowerCase();
      const y = r.tokenB.toLowerCase();
      return (x === a && y === b) || (x === b && y === a);
    }) ?? null
  );
}
