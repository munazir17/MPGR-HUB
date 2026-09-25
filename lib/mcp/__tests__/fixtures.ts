// Test fixtures for the MCP / executor TS layer (not a test file itself).
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";

import type { ChainReader } from "@/lib/executor/executor-chain";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_UNISWAP_V3,
  CANONICAL_PERMIT2,
  CANONICAL_WETH,
  RouterKind,
  type ExecutorChainId,
  type ExecutorDeployment,
} from "@/lib/executor/executor-config";
import type { ReceiptLike } from "@/lib/executor/executor-verify";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import type { McpDeps } from "@/lib/mcp/mcp-trade-service";

// Low-entropy, runtime-built test key (no secret-shaped literal in source).
export const TEST_SECRET = "t".repeat(48);
export const EXECUTOR = getAddress("0x00000000000000000000000000000000000e7ec0");
export const OWNER = getAddress("0x00000000000000000000000000000000000000a1");
export const FEE_RECIPIENT = OWNER;
export const TUSD = getAddress("0x0000000000000000000000000000000000007d5d");
export const TSTOCK = getAddress("0x000000000000000000000000000000000057acc0");
export const WETH = CANONICAL_WETH;
export const PERMIT2 = CANONICAL_PERMIT2;
export const ROUTER = getAddress(BASE_SEPOLIA_UNISWAP_V3.swapRouter02);
export const QUOTER = getAddress(BASE_SEPOLIA_UNISWAP_V3.quoterV2);

// Base mainnet (8453) — the real deployed values (mirrored by
// BASE_MAINNET_EXECUTOR_DEPLOYMENT in executor-config.ts, enforced there by
// executor-registry.test.ts against deployments/base-mainnet/mpgr-executor.json).
export const MAINNET_EXECUTOR = getAddress("0xD982726e28275661F8aB64054E6b17a70a63505A");
export const MAINNET_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
export const MAINNET_WETH = CANONICAL_WETH;
export const MAINNET_SLIP_ROUTER = getAddress("0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F");
export const MAINNET_SLIP_QUOTER = getAddress("0x514c8B5f54112481E28028F1166Bd78501089259");
export const MAINNET_TICK_SPACING = 50;

export const SEPOLIA_DEPLOYMENT: ExecutorDeployment = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  network: "base-sepolia",
  executor: EXECUTOR,
  owner: OWNER,
  feeRecipient: FEE_RECIPIENT,
  feeBps: 25,
  weth: WETH,
  permit2: PERMIT2,
  deployTx: `0x${"11".repeat(32)}`,
  deployBlock: 1234,
  explorerUrl: "https://sepolia.basescan.org",
  tokens: [
    { address: TUSD, symbol: "tUSD", decimals: 6, testnet: true },
    { address: TSTOCK, symbol: "tSTOCK", decimals: 18, testnet: true },
    { address: WETH, symbol: "WETH", decimals: 18, isWeth: true },
  ],
  routes: [
    { kind: RouterKind.UNISWAP_V3_ROUTER02, router: ROUTER, quoter: QUOTER, poolFee: 3000, tokenA: TUSD, tokenB: TSTOCK },
    { kind: RouterKind.UNISWAP_V3_ROUTER02, router: ROUTER, quoter: QUOTER, poolFee: 3000, tokenA: WETH, tokenB: TUSD },
  ],
};

/** Mirrors BASE_MAINNET_EXECUTOR_DEPLOYMENT: USDC <-> WETH on Slipstream only (no B20). */
export const MAINNET_DEPLOYMENT: ExecutorDeployment = {
  chainId: BASE_MAINNET_CHAIN_ID,
  network: "base",
  executor: MAINNET_EXECUTOR,
  owner: OWNER,
  feeRecipient: FEE_RECIPIENT,
  feeBps: 25,
  weth: MAINNET_WETH,
  permit2: PERMIT2,
  deployTx: `0x${"22".repeat(32)}`,
  deployBlock: 51767139,
  explorerUrl: "https://basescan.org",
  tokens: [
    { address: MAINNET_USDC, symbol: "USDC", decimals: 6 },
    { address: MAINNET_WETH, symbol: "WETH", decimals: 18, isWeth: true },
  ],
  routes: [
    {
      kind: RouterKind.AERODROME_SLIPSTREAM,
      router: MAINNET_SLIP_ROUTER,
      quoter: MAINNET_SLIP_QUOTER,
      tickSpacing: MAINNET_TICK_SPACING,
      tokenA: MAINNET_USDC,
      tokenB: MAINNET_WETH,
    },
  ],
};

export const TEST_REGISTRY: Record<ExecutorChainId, ExecutorDeployment | null> = {
  [BASE_MAINNET_CHAIN_ID]: null,
  [BASE_SEPOLIA_CHAIN_ID]: SEPOLIA_DEPLOYMENT,
};

/** The production-shaped registry: BOTH chains have a deployed executor. */
export const MAINNET_REGISTRY: Record<ExecutorChainId, ExecutorDeployment | null> = {
  [BASE_MAINNET_CHAIN_ID]: MAINNET_DEPLOYMENT,
  [BASE_SEPOLIA_CHAIN_ID]: SEPOLIA_DEPLOYMENT,
};

/** Mutable on-chain state for the fake reader. */
export interface FakeChainState {
  feeBps: number;
  feeRecipient: Address;
  paused: boolean;
  /** token -> owner -> balance */
  balances: Map<string, bigint>;
  allowances: Map<string, bigint>;
  ethBalance: bigint;
  permitNonce: bigint;
  /** tokens that implement EIP-2612 + EIP-5267 */
  permitTokens: Set<string>;
  /** quoter output multiplier: out = amountIn * num / den */
  quoteNum: bigint;
  quoteDen: bigint;
  quoterFails: boolean;
  receipts: Map<string, ReceiptLike>;
  calls: string[];
}

const k = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(":");

export function newFakeState(): FakeChainState {
  return {
    feeBps: 25,
    feeRecipient: FEE_RECIPIENT,
    paused: false,
    balances: new Map(),
    allowances: new Map(),
    ethBalance: 0n,
    permitNonce: 0n,
    permitTokens: new Set([TUSD.toLowerCase()]),
    quoteNum: 2n,
    quoteDen: 1n,
    quoterFails: false,
    receipts: new Map(),
    calls: [],
  };
}

export function setBalance(s: FakeChainState, token: Address, owner: Address, amount: bigint) {
  s.balances.set(k(token, owner), amount);
}
export function setAllowance(s: FakeChainState, token: Address, owner: Address, spender: Address, amount: bigint) {
  s.allowances.set(k(token, owner, spender), amount);
}

export function fakeReader(
  s: FakeChainState,
  chainId: number = BASE_SEPOLIA_CHAIN_ID,
  executorAddr: Address = EXECUTOR,
): ChainReader {
  return {
    chainId,
    async readContract({ address, functionName, args }) {
      s.calls.push(`read:${functionName}`);
      const a = (args ?? []) as unknown[];
      if (address.toLowerCase() === executorAddr.toLowerCase()) {
        switch (functionName) {
          case "feeBps":
            return s.feeBps;
          case "feeRecipient":
            return s.feeRecipient;
          case "paused":
            return s.paused;
          case "MAX_FEE_BPS":
            return 100;
          case "owner":
            return OWNER;
        }
      }
      if (address.toLowerCase() === PERMIT2.toLowerCase() && functionName === "nonceBitmap") return 0n;
      switch (functionName) {
        case "balanceOf":
          return s.balances.get(k(address, String(a[0]))) ?? 0n;
        case "allowance":
          return s.allowances.get(k(address, String(a[0]), String(a[1]))) ?? 0n;
        case "nonces":
          return s.permitNonce;
        case "eip712Domain":
          if (!s.permitTokens.has(address.toLowerCase())) throw new Error("execution reverted");
          return ["0x0f", "MPGR Test USD", "1", BigInt(chainId), address, `0x${"00".repeat(32)}`, []] as const;
      }
      throw new Error(`unexpected read ${functionName} on ${address}`);
    },
    async simulateContract({ functionName, args }) {
      s.calls.push(`simulate:${functionName}`);
      if (s.quoterFails) throw new Error("execution reverted: SPL");
      const p = (args as [{ amountIn: bigint }])[0];
      return { result: [(p.amountIn * s.quoteNum) / s.quoteDen, 0n, 0, 0n] };
    },
    async getBalance() {
      return s.ethBalance;
    },
    async getTransactionReceipt({ hash }) {
      const r = s.receipts.get(hash.toLowerCase());
      if (!r) throw new Error("TransactionReceiptNotFoundError");
      return r;
    },
  };
}

export function testDeps(s: FakeChainState, over: Partial<McpDeps> = {}): McpDeps & { clock: { now: number } } {
  const clock = { now: 1_800_000_000 };
  return {
    registry: TEST_REGISTRY,
    reader: (chainId) => fakeReader(s, chainId),
    nowSeconds: () => clock.now,
    quoteSecret: TEST_SECRET,
    mainnetEnabled: false,
    mainnetFeeRecipient: null,
    clock,
    ...over,
  };
}

const swapExecutedEvent = MPGR_EXECUTOR_ABI.find(
  (x) => x.type === "event" && x.name === "SwapExecuted",
) as Extract<(typeof MPGR_EXECUTOR_ABI)[number], { type: "event"; name: "SwapExecuted" }>;

export interface SwapExecutedArgs {
  taker: Address;
  router: Address;
  intentId: Hex;
  tokenIn: Address;
  tokenOut: Address;
  grossAmountIn: bigint;
  feeAmount: bigint;
  swapAmountIn: bigint;
  amountOut: bigint;
  feeRecipient: Address;
  feeBps: number;
  routerKind: number;
  flags: number;
}

/** A real ABI-encoded SwapExecuted log, as the executor would emit it. */
export function swapExecutedLog(emitter: Address, ev: SwapExecutedArgs): Log {
  const topics = encodeEventTopics({
    abi: [swapExecutedEvent],
    eventName: "SwapExecuted",
    args: { taker: ev.taker, router: ev.router, intentId: ev.intentId },
  } as never) as Hex[];
  const nonIndexed = swapExecutedEvent.inputs.filter((i) => !i.indexed);
  const values = nonIndexed.map((i) => (ev as unknown as Record<string, unknown>)[i.name]);
  const data = encodeAbiParameters(nonIndexed as never, values as never);
  return {
    address: emitter,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: `0x${"22".repeat(32)}`,
    blockNumber: 99n,
    logIndex: 0,
    transactionHash: `0x${"33".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

const transferEvent = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;

export function transferLog(token: Address, from: Address, to: Address, value: bigint): Log {
  const topics = encodeEventTopics({ abi: [transferEvent], eventName: "Transfer", args: { from, to } }) as Hex[];
  return {
    address: token,
    topics: topics as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockHash: `0x${"22".repeat(32)}`,
    blockNumber: 99n,
    logIndex: 1,
    transactionHash: `0x${"44".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  } as Log;
}
