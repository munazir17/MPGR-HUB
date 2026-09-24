import "server-only";

// lib/executor/executor-chain.ts
//
// Read-only chain access for the executor / MCP flow. Never signs, never sends.
// Behind a narrow `ChainReader` interface so tools are unit-testable with fakes.
// RPC URLs are SERVER env vars (not NEXT_PUBLIC): BASE_SEPOLIA_RPC_URL, BASE_RPC_URL.

import { randomBytes } from "node:crypto";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, type ExecutorChainId } from "./executor-config";
import type { ReceiptLike } from "./executor-verify";
import { MPGR_EXECUTOR_ABI } from "./mpgr-executor-abi";

export interface ChainReader {
  chainId: number;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  simulateContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<{ result: unknown }>;
  getBalance(args: { address: Address }): Promise<bigint>;
  getTransactionReceipt(args: { hash: Hex }): Promise<ReceiptLike>;
}

export function executorRpcUrl(chainId: ExecutorChainId): string {
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
  return process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
}

export function createChainReader(chainId: ExecutorChainId): ChainReader {
  const client = createPublicClient({
    chain: chainId === BASE_MAINNET_CHAIN_ID ? base : baseSepolia,
    transport: http(executorRpcUrl(chainId), { timeout: 10_000 }),
  });
  return {
    chainId,
    readContract: (a) => client.readContract(a as never),
    simulateContract: (a) => client.simulateContract(a as never) as Promise<{ result: unknown }>,
    getBalance: (a) => client.getBalance(a),
    getTransactionReceipt: async ({ hash }) => {
      const r = await client.getTransactionReceipt({ hash });
      return { status: r.status, transactionHash: r.transactionHash, blockNumber: r.blockNumber, from: r.from, to: r.to, logs: r.logs };
    },
  };
}

// ---------------------------------------------------------------- ABIs (minimal)

const ERC20_READ_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

const PERMIT2_ABI = [
  { type: "function", name: "nonceBitmap", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "w", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

const UNI_QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const SLIPSTREAM_QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "tickSpacing", type: "int24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// ---------------------------------------------------------------- reads

export interface ExecutorLiveConfig {
  feeBps: number;
  feeRecipient: Address;
  paused: boolean;
  maxFeeBps: number;
  owner: Address;
}

export async function readExecutorLiveConfig(reader: ChainReader, executor: Address): Promise<ExecutorLiveConfig> {
  const call = (functionName: string) => reader.readContract({ address: executor, abi: MPGR_EXECUTOR_ABI, functionName });
  const [feeBps, feeRecipient, paused, maxFeeBps, owner] = await Promise.all([
    call("feeBps"),
    call("feeRecipient"),
    call("paused"),
    call("MAX_FEE_BPS"),
    call("owner"),
  ]);
  return {
    feeBps: Number(feeBps),
    feeRecipient: feeRecipient as Address,
    paused: Boolean(paused),
    maxFeeBps: Number(maxFeeBps),
    owner: owner as Address,
  };
}

export async function quoteUniswapV3(
  reader: ChainReader,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<bigint> {
  const { result } = await reader.simulateContract({
    address: quoter,
    abi: UNI_QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return (result as readonly [bigint, ...unknown[]])[0];
}

export async function quoteSlipstream(
  reader: ChainReader,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  tickSpacing: number,
): Promise<bigint> {
  const { result } = await reader.simulateContract({
    address: quoter,
    abi: SLIPSTREAM_QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
  });
  return (result as readonly [bigint, ...unknown[]])[0];
}

export async function readAllowance(reader: ChainReader, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return (await reader.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "allowance", args: [owner, spender] })) as bigint;
}

export async function readTokenBalance(reader: ChainReader, token: Address, owner: Address): Promise<bigint> {
  return (await reader.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [owner] })) as bigint;
}

export async function readPermitNonce(reader: ChainReader, token: Address, owner: Address): Promise<bigint> {
  return (await reader.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "nonces", args: [owner] })) as bigint;
}

/** EIP-5267 domain (OZ ERC20Permit). Returns null if the token doesn't expose it. */
export async function readEip712Domain(
  reader: ChainReader,
  token: Address,
): Promise<{ name: string; version: string; verifyingContract: Address } | null> {
  try {
    const r = (await reader.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "eip712Domain" })) as readonly [
      Hex,
      string,
      string,
      bigint,
      Address,
      Hex,
      readonly bigint[],
    ];
    if (Number(r[3]) !== reader.chainId) return null;
    return { name: r[1], version: r[2], verifyingContract: r[4] };
  } catch {
    return null;
  }
}

/** Random unordered Permit2 nonce that is currently unused (checked via nonceBitmap). */
export async function pickUnusedPermit2Nonce(reader: ChainReader, permit2: Address, owner: Address): Promise<bigint> {
  for (let i = 0; i < 4; i++) {
    const nonce = BigInt(`0x${randomBytes(31).toString("hex")}`);
    const word = nonce >> 8n;
    const bit = nonce & 0xffn;
    const bitmap = (await reader.readContract({ address: permit2, abi: PERMIT2_ABI, functionName: "nonceBitmap", args: [owner, word] })) as bigint;
    if (((bitmap >> bit) & 1n) === 0n) return nonce;
  }
  throw new Error("Could not find an unused Permit2 nonce");
}
