// lib/executor/executor-config.ts
//
// Typed, compile-time registry of MPGR Executor deployments.
//
// Rules (AGENTS.md): typed chain config, no secrets, bigint math, no
// NEXT_PUBLIC secrets. Nothing here fetches or signs.
//
// Base mainnet (8453) is intentionally `null`: the executor is NOT deployed on
// mainnet. Base Sepolia (84532) is filled from
// deployments/base-sepolia/mpgr-executor.json after the label-triggered
// GitHub Actions deployment (.github/workflows/deploy-executor-base-sepolia.yml).

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

/**
 * Deployment registry.
 * - 8453: `null` — mainnet deployment is NOT allowed yet (see mainnet checklist in docs/EXECUTOR.md).
 * - 84532: populated after the Base Sepolia deployment run.
 */
export const MPGR_EXECUTOR_DEPLOYMENTS: Record<ExecutorChainId, ExecutorDeployment | null> = {
  [BASE_MAINNET_CHAIN_ID]: null,
  [BASE_SEPOLIA_CHAIN_ID]: null,
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
