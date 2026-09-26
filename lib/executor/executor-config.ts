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
// run 36110098967) plus the live contract allowlist, and registers exactly what
// the deployed executor can execute today — nothing more:
//   - USDC <-> WETH on the OFFICIAL Base Uniswap V3 deployment (SwapRouter02 +
//     QuoterV2, 0.30% pool), allowlisted by the owner tx
//     0x2341ff2234d9a58401fc3c3e0a4e3d26aa56cb62fd574ce48f8c3929dab964d1
//     (setRouter(SwapRouter02, 2), block 51792513, 2026-09-25 — confirmed on
//     chain; the record's routerAllowlist field still shows the deploy-time
//     Slipstream router because it is a deployment snapshot).
//   - USDC <-> each of the 13 Coinbase B20 tokenized stocks on the Aerodrome
//     Slipstream router (kind 1, allowlisted at construction — the SAME router,
//     pool key (tickSpacing 10) and tokens the app's executed B20 swap uses),
//     so every supported B20 swap takes its 25 bps fee inside the swap
//     transaction instead of a separate post-swap transfer.
// A pair with no registered route (an arbitrary ERC-20, WETH <-> B20,
// B20 <-> B20) is never routed through the executor — its provider keeps
// charging its own exact 25 bps.

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
 * `tokens`/`routes` are the routable subset and mirror the LIVE contract
 * allowlist, verified against Base Mainnet:
 *   - tokens: USDC, WETH and all 13 Coinbase B20 tokenized stocks (the
 *     constructor's allowlist; re-verified live by
 *     test/fork/MPGRExecutorBaseMainnetDeployment.t.sol).
 *   - routers: Aerodrome Slipstream (kind 1, constructor) and the official
 *     Base Uniswap V3 SwapRouter02 (kind 2, owner tx
 *     0x2341ff2234d9a58401fc3c3e0a4e3d26aa56cb62fd574ce48f8c3929dab964d1,
 *     confirmed on chain 2026-09-25, block 51792513).
 *
 * Every registered route therefore executes on the deployed contract with the
 * 25 bps fee taken inside the swap transaction:
 *   - USDC <-> WETH: official Base Uniswap V3 WETH/USDC 0.30% pool (fee 3000,
 *     pool 0x6c561B446416E1A00E8E93E221854d6eA4171372, CREATE2-derived from
 *     the Uniswap V3 factory).
 *   - USDC <-> each B20 stock: the Aerodrome Slipstream USDC pool the app's
 *     tokenized-stock flow already trades (tickSpacing 10) — the same pool,
 *     same tickSpacing and same router, only with the fee collected in-swap
 *     by the executor instead of by a separate post-swap transfer.
 *
 * Anything not registered here (a B20<->B20 pair, WETH<->B20, an arbitrary
 * ERC-20) is NOT executor-routable and keeps its existing provider, so no
 * route is ever invented for the executor.
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

/** Aerodrome Slipstream on Base Mainnet (Gauges V3): the venue for every USDC <-> B20 tokenized
 *  stock route below (tickSpacing 10), allowlisted on the deployed executor as kind 1 since the
 *  constructor (no owner transaction needed). Re-verified live by
 *  test/fork/MPGRExecutorBaseMainnetDeployment.t.sol. */
export const BASE_MAINNET_SLIPSTREAM = {
  factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  quoterV2: "0x514c8B5f54112481E28028F1166Bd78501089259",
  swapRouter: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
} as const satisfies Record<string, Address>;

/** Aerodrome Slipstream B20/USDC pools are tickSpacing 10 (0.05% fee) — the same pool key the
 *  app's tokenized-stock flow quotes and the one the live executor swap is proven against
 *  (tx 0x0f52a3b3a13e8fabf79f9185bc3198e60275223ceb4225b24c84782aa43551de: USDC -> AAPLc,
 *  tickSpacing 10, 2 USDC). Mirrored by lib/trade/trade-config.ts AERODROME_B20_TICK_SPACING. */
export const BASE_MAINNET_B20_TICK_SPACING = 10;

/**
 * Coinbase B20 tokenized stocks on Base Mainnet — every one is allowlisted on the deployed
 * executor and priced through the executor's Aerodrome Slipstream USDC pool.
 *
 * `decimals` is 8 for every issued B20 stock: read live from each token contract (AAPLc, AMZNc,
 * GOOGLc, METAc, MSFTc, MSTRc, NVDAc, SNDKc, SPCXc, TSLAc) and consistent with the on-chain
 * transfer amounts this app has executed. It is a display/parse default only — the swap path
 * re-reads `decimals()` live and fails closed if it cannot be verified
 * (lib/trade/tokenized-stocks-onchain.ts).
 */
export const BASE_MAINNET_B20_TOKENS = [
  { address: "0xb200000000000000000000C2e324d24d7eEcd1fb", symbol: "AAPLc", decimals: 8 },
  { address: "0xb200000000000000000000d9192b6B456483C2E8", symbol: "AMZNc", decimals: 8 },
  { address: "0xb200000000000000000000c85a31389D71F3ecfb", symbol: "COINc", decimals: 8 },
  { address: "0xB20000000000000000000019f6E7C675b73C2e4D", symbol: "CRCLc", decimals: 8 },
  { address: "0xb2000000000000000000002D0BA3164cc74f58B7", symbol: "GOOGLc", decimals: 8 },
  { address: "0xB2000000000000000000004AFF16039bA04bdFBc", symbol: "INTCc", decimals: 8 },
  { address: "0xb2000000000000000000008bC8786B856E61707C", symbol: "METAc", decimals: 8 },
  { address: "0xB200000000000000000000Ab99cFa739E253872B", symbol: "MSFTc", decimals: 8 },
  { address: "0xb2000000000000000000004884b426556b92883d", symbol: "MSTRc", decimals: 8 },
  { address: "0xb20000000000000000000078ee7ce2fE4908108C", symbol: "NVDAc", decimals: 8 },
  { address: "0xb200000000000000000000397293Cb8cda9a10c5", symbol: "SNDKc", decimals: 8 },
  { address: "0xb2000000000000000000007b9fcbd005511aCBd5", symbol: "SPCXc", decimals: 8 },
  { address: "0xb2000000000000000000001e800a7f5189430cD0", symbol: "TSLAc", decimals: 8 },
] as const satisfies readonly ExecutorToken[];

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
    ...BASE_MAINNET_B20_TOKENS.map((token) => ({ ...token })),
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
    // USDC <-> each B20 tokenized stock through the registered Slipstream router, exactly the
    // pool the app's B20 flow already trades — now with the fee collected inside the swap.
    ...BASE_MAINNET_B20_TOKENS.map((token) => ({
      kind: RouterKind.AERODROME_SLIPSTREAM,
      router: BASE_MAINNET_SLIPSTREAM.swapRouter,
      quoter: BASE_MAINNET_SLIPSTREAM.quoterV2,
      tickSpacing: BASE_MAINNET_B20_TICK_SPACING,
      tokenA: BASE_MAINNET_USDC,
      tokenB: token.address as Address,
    })),
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
