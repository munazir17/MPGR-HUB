import "server-only";

// lib/executor/executor-chain.ts
//
// Read-only chain access for the executor / MCP flow. Never signs, never sends.
// Behind a narrow `ChainReader` interface so tools are unit-testable with fakes.
// RPC URLs are SERVER env vars (not NEXT_PUBLIC): BASE_SEPOLIA_RPC_URL, BASE_RPC_URL.

import { randomBytes } from "node:crypto";
import { createPublicClient, fallback, http, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, type ExecutorChainId } from "./executor-config";
import type { ReceiptLike } from "./executor-verify";
import { MPGR_EXECUTOR_ABI } from "./mpgr-executor-abi";

export interface ChainReader {
  chainId: number;
  getBytecode?(args: { address: Address }): Promise<Hex | null>;
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

// Second public Base mainnet endpoint used ONLY when no server RPC is
// configured (see createChainReader). Kept as a literal here — importing
// transport plumbing from lib/trade would couple the executor to a module
// several route tests replace with minimal mocks.
const BASE_MAINNET_PUBLIC_FALLBACK_RPC = "https://base-rpc.publicnode.com";

// ---------------------------------------------------------------------------
// Receipt-read hardening (application-level, additive).
//
// Defect (observed live on the successful autonomous Mainnet canary,
// tx 0xa922…5693c): base-rpc.publicnode.com rejected a NORMAL recent-block
// eth_getTransactionReceipt with a JSON-RPC error body (HTTP 200, code
// -32602 "Archive requests require a personal token"). viem's `fallback`
// transport only re-routes on TRANSPORT failures (network/timeout/HTTP
// status) — a JSON-RPC error body is a "successful" HTTP response, so the
// documented transport fallback never engaged and receipt verification
// crashed even though the receipt was readable on every other public node.
//
// Fix: an explicit, deterministic, RECEIPT-ONLY retry across the documented
// PUBLIC Base endpoints. Scope discipline:
//  - verification itself is untouched (status/from/to/logs are still proven
//    by verifyExecutorReceipt — only WHERE the receipt is read from changes);
//  - the audited transport rule stands: a CONFIGURED BASE_RPC_URL keeps
//    exactly one transport for regular reads — this fallback applies only
//    to getTransactionReceipt AFTER the primary read errored;
//  - PUBLIC, key-less endpoints only; never any secret or paid token;
//  - all endpoints failing rethrows the ORIGINAL error (fail closed).
const BASE_MAINNET_RECEIPT_FALLBACK_URLS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] as const;

/** origin-only (paths/credentials never logged — mirrors trade-public-client discipline). */
function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "<receipt-fallback>";
  }
}

interface MinimalReceiptClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    status: "success" | "reverted";
    transactionHash: Hex;
    blockNumber: bigint;
    from: Address;
    to: Address | null;
    logs: readonly unknown[];
  }>;
}

function toReceiptLike(r: Awaited<ReturnType<MinimalReceiptClient["getTransactionReceipt"]>>): import("./executor-verify").ReceiptLike {
  return { status: r.status, transactionHash: r.transactionHash, blockNumber: r.blockNumber, from: r.from, to: r.to, logs: r.logs as import("./executor-verify").ReceiptLike["logs"] };
}

/**
 * Reads a transaction receipt through `primary`; if the primary errors
 * (e.g. an archive-policy JSON-RPC rejection), retries the SAME read
 * once per PUBLIC fallback endpoint in deterministic order. Fail-closed:
 * if every read fails, the original error is rethrown.
 *
 * `clientFactory` is injectable for offline tests; production uses viem.
 */
export async function readTransactionReceiptWithFallback(
  chainId: ExecutorChainId,
  hash: Hex,
  primary: () => Promise<import("./executor-verify").ReceiptLike>,
  opts: { clientFactory?: (url: string) => MinimalReceiptClient; urls?: readonly string[] } = {},
): Promise<import("./executor-verify").ReceiptLike> {
  let primaryError: unknown;
  try {
    return await primary();
  } catch (error) {
    if (chainId !== BASE_MAINNET_CHAIN_ID) throw error; // fallbacks defined for Base mainnet only
    primaryError = error;
  }
  const urls = opts.urls ?? BASE_MAINNET_RECEIPT_FALLBACK_URLS;
  let lastError: unknown = primaryError;
  for (const url of urls) {
    try {
      const client = opts.clientFactory ? opts.clientFactory(url) : createPublicClient({ chain: base, transport: http(url, { timeout: 10_000, retryCount: 0 }) });
      const receipt = await (client as MinimalReceiptClient).getTransactionReceipt({ hash });
      console.error(`[executor-rpc] primary receipt read failed; served by fallback ${safeOrigin(url)} (verification unchanged)`);
      return toReceiptLike(receipt);
    } catch (error) {
      lastError = error;
    }
  }
  throw primaryError;
}

const RECEIPT_NOT_FOUND = /could not be found|not found/i;

/**
 * Polls for a receipt (wait-for-inclusion) using a ChainReader whose
 * getTransactionReceipt is fallback-hardened. Tolerates "not yet mined"
 * (ReceiptNotFoundError) and endpoint errors until the deadline; throws
 * the last error otherwise. Does NOT alter what verification then proves.
 */
export async function waitForTransactionReceiptWithFallback(
  chainId: ExecutorChainId,
  hash: Hex,
  reader: Pick<ChainReader, "getTransactionReceipt">,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<import("./executor-verify").ReceiptLike> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await reader.getTransactionReceipt({ hash });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!RECEIPT_NOT_FOUND.test(message) && Date.now() >= deadline) throw lastError;
      if (Date.now() + intervalMs > deadline) throw lastError;
    }
    await sleep(intervalMs);
  }
}

export function createChainReader(chainId: ExecutorChainId): ChainReader {
  // Transport hardening (behavior-preserving):
  //  - BASE_RPC_URL configured → EXACTLY one transport, byte-identical to
  //    the audited rule "a configured provider failure does not silently
  //    fall back" (docs/MAINNET_TRADING_AUDIT_2026-09-26.md item 8).
  //  - Nothing configured → keep the documented public default first and
  //    add ONE extra public endpoint behind it, so preview/dev deployments
  //    without a server RPC survive mainnet.base.org rate limiting.
  //  - Bounded 10 s timeouts; viem's client-level retry (3 retries,
  //    150→600 ms backoff) is finite; Sepolia unchanged.
  const configured = Boolean(process.env.BASE_RPC_URL?.trim());
  const timeout = 10_000;
  const client =
    chainId === BASE_MAINNET_CHAIN_ID && !configured
      ? createPublicClient({
          chain: base,
          transport: fallback([
            http(executorRpcUrl(chainId), { timeout }),
            http(BASE_MAINNET_PUBLIC_FALLBACK_RPC, { timeout }),
          ]),
        })
      : createPublicClient({
          chain: chainId === BASE_MAINNET_CHAIN_ID ? base : baseSepolia,
          transport: http(executorRpcUrl(chainId), { timeout }),
        });
  return {
    chainId,
    getBytecode: async ({ address }) => (await client.getBytecode({ address })) ?? null,
    readContract: (a) => client.readContract(a as never),
    simulateContract: (a) => client.simulateContract(a as never) as Promise<{ result: unknown }>,
    getBalance: (a) => client.getBalance(a),
    getTransactionReceipt: async ({ hash }) =>
      readTransactionReceiptWithFallback(chainId, hash, async () => {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, transactionHash: r.transactionHash, blockNumber: r.blockNumber, from: r.from, to: r.to, logs: r.logs };
      }),
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
