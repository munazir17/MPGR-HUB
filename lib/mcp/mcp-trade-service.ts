import "server-only";

// lib/mcp/mcp-trade-service.ts
//
// Business logic behind the MPGR MCP tools:
//   discover -> quote -> prepare -> (user wallet signs) -> finalize -> execute (user) -> status -> verify
//
// HARD RULES
//   * Never signs, never sends, never sees a private key. Every output is
//     UNSIGNED data (transaction requests / EIP-712 typed data) for the
//     user's own wallet.
//   * Fee = floor(sellAmount * feeBps / 10_000) of the SELL token, collected in
//     the SAME transaction as the swap (executor on-chain, or 0x native fee).
//     No path ever skips the fee or charges it twice.
//   * Every economically relevant field is bound into a server-HMAC'd quoteId;
//     prepare/finalize/verify re-derive the intent from it.

import {
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  parseEventLogs,
  parseUnits,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type Log,
  encodeFunctionData,
} from "viem";
import { normalizeWalletSignature } from "@/lib/executor/wallet-signature";

import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  EXECUTOR_CHAIN_NAMES,
  EXECUTOR_DEFAULT_FEE_BPS,
  EXECUTOR_EXPLORERS,
  EXECUTOR_MAX_FEE_BPS,
  RouterKind,
  findExecutorRoute,
  findExecutorToken,
  isExecutorChainId,
  type AuthorizationMode,
  type ExecutorChainId,
  type ExecutorDeployment,
  type ExecutorRoute,
  type ExecutorToken,
} from "@/lib/executor/executor-config";
import {
  pickUnusedPermit2Nonce,
  quoteSlipstream,
  quoteUniswapV3,
  readAllowance,
  readEip712Domain,
  readExecutorLiveConfig,
  readPermitNonce,
  readTokenBalance,
  type ChainReader,
} from "@/lib/executor/executor-chain";
import { computeExecutorFee } from "@/lib/executor/executor-fee";
import {
  EXECUTOR_MAX_SLIPPAGE_BPS,
  EXECUTOR_MIN_SLIPPAGE_BPS,
  approvalAuthorization,
  authorizationFromSignature,
  buildEip2612TypedData,
  buildExecutorIntent,
  buildPermit2TypedData,
  encodeExactApproval,
  encodeExecutorSwap,
  type ExecutorSwapIntent,
  type UnsignedTransactionRequest,
} from "@/lib/executor/executor-intent";
import { verifyExecutorReceipt } from "@/lib/executor/executor-verify";
import { MPGR_TOKEN_ADDRESS } from "@/lib/chain/base";
import { BASE_USDC, BASE_WETH, isNativeEthSentinel } from "@/lib/trade/trade-config";
import { V2_FEE_RECIPIENT } from "@/lib/swap/v2/discovery";
import { SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/sealed-manifest";
import {
  inspectPaigerSwapV2Binding,
  paigerSwapV2QuoteView,
  parsePaigerSwapV2Binding,
  verifyPaigerSwapV2Trade,
  type PaigerSwapV2Port,
} from "./paigerswap-v2";
import {
  ZERO_EX_ALLOWANCE_HOLDER_BASE,
  getZeroExNativeFeeQuote,
  type ZeroExNativeFeeQuote,
} from "@/lib/trade/zero-ex-native-fee";
import { QUOTE_TTL_SECONDS, signQuoteId, verifyQuoteId, type QuotePayload } from "./quote-id";

export const MCP_SERVER_NAME = "mpgr-agent";
export const MCP_SERVER_VERSION = "1.0.0";
/** Intent deadline = quote issue time + this (deterministic across prepare/finalize/verify). */
export const INTENT_TTL_SECONDS = 600;
const DEFAULT_SLIPPAGE_BPS = 100;

export interface McpDeps {
  registry: Record<ExecutorChainId, ExecutorDeployment | null>;
  /**
   * Phase 3 delegated path: route registry for MPGRExecutorDelegated (Base
   * Sepolia). Selected ONLY when a quote explicitly passes the pinned
   * delegated executor address as `executor` — never as a silent default.
   */
  delegatedRegistry?: Partial<Record<ExecutorChainId, ExecutorDeployment>>;
  reader: (chainId: ExecutorChainId) => ChainReader;
  nowSeconds: () => number;
  quoteSecret?: string;
  /**
   * Phase 2 delegated path ONLY: the operator broadcaster (Base Sepolia).
   * Fail-closed: when absent, mpgr_delegate_swap refuses. Never user keys.
   */
  delegatedBroadcaster?: (tx: { to: Address; data: Hex; chainId: number; value?: bigint }, onStage?: (stage: "estimate" | "send") => void) => Promise<Hex>;
  /**
   * Base mainnet MCP trading (executor path AND 0x fallback). OFF unless
   * MPGR_MCP_ENABLE_BASE_MAINNET=true. The registry entry is a deployed fact;
   * this flag is the operator's trading switch.
   */
  mainnetEnabled: boolean;
  /** Validated MPGR fee wallet for the 0x fallback path (null => non-executor mainnet quotes refused). */
  mainnetFeeRecipient: Address | null;
  zeroExFetch?: typeof fetch;
  /**
   * PaigerSwap V2 for Base mainnet pairs the legacy executor does not already
   * route. Absent or inactive preserves the previous 0x fallback. Never signs.
   */
  paigerSwapV2?: PaigerSwapV2Port;
}

export type ToolOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

const fail = (code: string, message: string): ToolOutcome => ({ ok: false, error: { code, message } });

/** JSON-safe deep copy: bigint -> decimal string. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function parseChainId(raw: unknown): ExecutorChainId | null {
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return isExecutorChainId(n) ? n : null;
}

function tokenView(t: ExecutorToken) {
  return { address: t.address, symbol: t.symbol, decimals: t.decimals, isWeth: t.isWeth === true, testnet: t.testnet === true };
}

/** Accepts an address, a symbol from the executor allowlist, or "ETH" (native, via WETH). */
function resolveToken(d: ExecutorDeployment, raw: unknown): { token: ExecutorToken; native: boolean } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return null;
  if (raw.toUpperCase() === "ETH") {
    const weth = d.tokens.find((t) => t.isWeth);
    return weth ? { token: weth, native: true } : null;
  }
  if (isAddress(raw)) {
    const t = findExecutorToken(d, raw);
    return t ? { token: t, native: false } : null;
  }
  const bySymbol = d.tokens.find((t) => t.symbol.toLowerCase() === raw.toLowerCase());
  return bySymbol ? { token: bySymbol, native: false } : null;
}

function parseSellAmount(args: Record<string, unknown>, decimals: number): bigint | string {
  const raw = args.sellAmount;
  const human = args.sellAmountHuman;
  if (typeof raw === "string" && raw.length > 0) {
    if (!/^\d{1,78}$/.test(raw)) return "sellAmount must be an integer string in base units.";
    return BigInt(raw);
  }
  if (typeof human === "string" && human.length > 0) {
    if (!/^\d{1,40}(\.\d{1,36})?$/.test(human)) return "sellAmountHuman must be a positive decimal string.";
    const [, frac = ""] = human.split(".");
    if (frac.length > decimals) return `sellAmountHuman has more than ${decimals} decimals.`;
    return parseUnits(human, decimals);
  }
  return "Provide sellAmount (base units) or sellAmountHuman (decimal).";
}

function parseSlippage(raw: unknown): number | string {
  if (raw === undefined || raw === null) return DEFAULT_SLIPPAGE_BPS;
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < EXECUTOR_MIN_SLIPPAGE_BPS || n > EXECUTOR_MAX_SLIPPAGE_BPS) {
    return `slippageBps must be an integer between ${EXECUTOR_MIN_SLIPPAGE_BPS} and ${EXECUTOR_MAX_SLIPPAGE_BPS}.`;
  }
  return n;
}

function routeView(intent: ExecutorSwapIntent) {
  return {
    provider: "mpgr-executor",
    venue: intent.routerKind === RouterKind.UNISWAP_V3_ROUTER02 ? "uniswap-v3" : "aerodrome-slipstream",
    executor: intent.executor,
    router: intent.router,
    poolFee: intent.poolFee ?? null,
    tickSpacing: intent.tickSpacing ?? null,
    hops: 1,
  };
}

function intentView(intent: ExecutorSwapIntent, quoteId: string) {
  return {
    quoteId,
    chainId: intent.chainId,
    taker: intent.taker,
    recipient: intent.recipient,
    sellToken: tokenView(intent.sellToken),
    buyToken: tokenView(intent.buyToken),
    sellNative: intent.sellNative,
    buyNative: intent.buyNative,
    sellAmount: intent.sellAmount,
    sellAmountHuman: formatUnits(BigInt(intent.sellAmount), intent.sellToken.decimals),
    expectedBuyAmount: intent.expectedBuyAmount,
    expectedBuyAmountHuman: formatUnits(BigInt(intent.expectedBuyAmount), intent.buyToken.decimals),
    minBuyAmount: intent.minBuyAmount,
    minBuyAmountHuman: formatUnits(BigInt(intent.minBuyAmount), intent.buyToken.decimals),
    slippageBps: intent.slippageBps,
    feeBps: intent.feeBps,
    feeAmount: intent.feeAmount,
    feeAmountHuman: formatUnits(BigInt(intent.feeAmount), intent.sellToken.decimals),
    feeToken: intent.feeToken,
    feeRecipient: intent.feeRecipient,
    feeCollection: "same-transaction (executor, on-chain, exact)",
    swapAmount: intent.swapAmount,
    route: routeView(intent),
    executor: intent.executor,
    spender: intent.spender,
    authorization: intent.authorization,
    deadline: intent.deadline,
    intentId: intent.intentId,
  };
}

// ============================================================ discover

export function getCapabilities(deps: McpDeps): ToolOutcome {
  const chains = ([BASE_SEPOLIA_CHAIN_ID, BASE_MAINNET_CHAIN_ID] as const).map((chainId) => {
    const d = deps.registry[chainId];
    const isMainnet = chainId === BASE_MAINNET_CHAIN_ID;
    // Mainnet: both providers are behind the operator flag; the executor path
    // needs the registered deployment, the 0x fallback needs the fee wallet.
    const tradingProviders: string[] = isMainnet
      ? deps.mainnetEnabled
        ? [
            ...(d ? ["mpgr-executor"] : []),
            ...(deps.paigerSwapV2?.activated ? ["paigerswap-v2"] : []),
            ...(deps.mainnetFeeRecipient ? ["0x-native-fee"] : []),
          ]
        : []
      : d
        ? ["mpgr-executor"]
        : [];
    return {
      chainId,
      name: EXECUTOR_CHAIN_NAMES[chainId],
      explorer: EXECUTOR_EXPLORERS[chainId],
      executor: d
        ? { status: "deployed", address: d.executor, owner: d.owner, feeRecipient: d.feeRecipient, deployTx: d.deployTx, deployBlock: d.deployBlock }
        : { status: "not_deployed" },
      /** Operator trading switch: mainnet follows MPGR_MCP_ENABLE_BASE_MAINNET, Sepolia the deployment. */
      tradingEnabled: isMainnet ? deps.mainnetEnabled : d !== null,
      tradingProviders,
      tokens: d ? d.tokens.map(tokenView) : [],
    };
  });
  return {
    ok: true,
    data: {
      server: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      flow: [
        "mpgr_get_capabilities / mpgr_list_tokens (discover)",
        "mpgr_get_quote -> quoteId (expires in 120s)",
        "mpgr_prepare_trade(quoteId, authorization) -> unsigned approval tx and/or EIP-712 typed data and/or swap tx",
        "USER WALLET signs typed data / sends txs (the AI never signs)",
        "mpgr_finalize_trade(quoteId, signature, permitNonce) -> unsigned swap tx (permit modes only)",
        "mpgr_get_trade_status(txHash) -> mpgr_verify_trade(quoteId, txHash)",
      ],
      custody: "Non-custodial. This server never holds keys, never signs, never broadcasts.",
      fee: {
        label: "0.25% trading fee",
        bps: EXECUTOR_DEFAULT_FEE_BPS,
        maxBps: EXECUTOR_MAX_FEE_BPS,
        token: "sell token (native ETH when selling ETH)",
        formula: "floor(sellAmount * feeBps / 10000)",
        collection: "Same transaction as the swap. Executor: on-chain exact fee. 0x: native integrator fee verified exact.",
        liveFeeBpsSource: "MPGRExecutor.feeBps() (owner-configurable, hard cap 100 bps)",
      },
      authorizationModes: {
        APPROVAL: "ERC-20 approve(executor, exact sellAmount) tx, then the swap tx. Native ETH sells need no approval.",
        EIP2612: "Sign an EIP-2612 permit (typed data) — permit + fee + swap happen in ONE tx. Token must support permit.",
        PERMIT2: "One-time approve(Permit2), then sign a Permit2 SignatureTransfer per trade — ONE swap tx.",
      },
      baseMainnetDispatch: deps.paigerSwapV2?.activated
        ? "Registered executor pairs stay on the legacy MPGR Executor: USDC<->WETH (Uniswap V3, fee 3000) and USDC<->each B20 tokenized stock (Aerodrome Slipstream, tickSpacing 10). Other Base pairs, including MPGR, are quoted through the sealed PaigerSwap V2 executor when it can simulate a route. A completed V2 search with no pool may use the 0x native-fee path. A V2 simulation, RPC, or fee failure is an error and is not replaced with another route."
        : "Registered executor pairs route through the MPGR Executor: USDC<->WETH (Uniswap V3, fee 3000) and USDC<->each B20 tokenized stock (Aerodrome Slipstream, tickSpacing 10), all incl. native ETH where applicable and all with the 0.25% trading fee taken inside the swap transaction. Any other pair (arbitrary ERC-20, WETH<->B20, B20<->B20) falls back to the 0x native-fee path.",
      providers: {
        "mpgr-executor": "Custom MPGR executor (NOT externally audited yet): typed Aerodrome Slipstream + Uniswap V3 adapters, allowlisted routers/tokens, exact fee, atomic. Deployed on Base mainnet and Base Sepolia.",
        "0x-native-fee": "0x Swap API (AllowanceHolder) with swapFeeToken=sellToken; quote rejected unless the integrator fee is exactly floor(sellAmount*25/10000) of the sell token. Base mainnet only, for pairs V2 could not route and that have no proven legacy executor route; disabled by default.",
        "paigerswap-v2": "Sealed PaigerSwap V2 executor on Base. Used by mpgr_get_quote for pairs the legacy executor does not already route, only while V2 routing is activated and Base mainnet MCP trading is enabled. Reuses V2 discovery, calldata, the single 0.25% trading fee on gross, and eth_call simulation. The wallet still confirms the unsigned transaction.",
        "uniswap-v3":
          "Venue used by mpgr-executor on Base mainnet (USDC<->WETH, fee 3000 — the official Base Uniswap V3 0.30% pool) and on Base Sepolia (tUSD/tSTOCK and WETH/tUSD, fee 3000). Swaps go through Uniswap V3 SwapRouter02 exactInputSingle; the pool is verified by CREATE2 against the official factory.",
        "aerodrome-slipstream":
          "The executor's Base mainnet venue for every USDC <-> B20 tokenized stock (tickSpacing 10), allowlisted as kind 1 since the constructor. The app's executed USDC<->AAPLc swaps (tx 0x0f52a3b3a13e8fabf79f9185bc3198e60275223ceb4225b24c84782aa43551de) use exactly this router, pool key and tickSpacing. The old USDC<->WETH Slipstream route (tickSpacing 50) is no longer registered — USDC<->WETH runs on official Uniswap V3.",
        "cdp-trade-api": "Not offered over MCP: CDP Swap API has no integrator-fee parameter and returns taker-bound calldata; the app UI keeps its existing flow (incl. B20 tokenized stocks).",
      },
      chains,
    },
  };
}

export function listTokens(deps: McpDeps, input: unknown): ToolOutcome {
  const args = asRecord(input);
  const chainId = parseChainId(args.chainId ?? BASE_SEPOLIA_CHAIN_ID);
  if (!chainId) return fail("UNSUPPORTED_CHAIN", "chainId must be 84532 (Base Sepolia) or 8453 (Base).");
  const d = deps.registry[chainId];
  if (!d) {
    return fail(
      chainId === BASE_MAINNET_CHAIN_ID ? "EXECUTOR_NOT_DEPLOYED_MAINNET" : "EXECUTOR_NOT_DEPLOYED",
      chainId === BASE_MAINNET_CHAIN_ID
        ? "The MPGR Executor is not deployed on Base mainnet. Mainnet 0x trades accept any ERC-20 address."
        : "The MPGR Executor is not yet deployed on Base Sepolia.",
    );
  }
  return {
    ok: true,
    data: {
      chainId,
      executor: d.executor,
      /** Operator trading switch: mainnet follows MPGR_MCP_ENABLE_BASE_MAINNET, Sepolia the deployment. */
      tradingEnabled: chainId === BASE_MAINNET_CHAIN_ID ? deps.mainnetEnabled : true,
      nativeEth: { symbol: "ETH", via: d.weth, note: "Use \"ETH\" as sellToken/buyToken for native ETH." },
      tokens: d.tokens.map(tokenView),
      pairs: d.routes.map((r) => ({
        tokenA: r.tokenA,
        tokenB: r.tokenB,
        venue:
          r.kind === RouterKind.UNISWAP_V3_ROUTER02
            ? "uniswap-v3"
            : r.kind === RouterKind.AERODROME_SLIPSTREAM
              ? "aerodrome-slipstream"
              : "typed-swap-module",
        poolFee: r.poolFee ?? null,
        tickSpacing: r.tickSpacing ?? null,
      })),
      ...(chainId === BASE_MAINNET_CHAIN_ID
        ? {
            note: deps.paigerSwapV2?.activated
              ? "Every pair listed here is routable through the legacy MPGR Executor, which takes the 0.25% trading fee inside the swap transaction. Other Base pairs, including MPGR, are quoted through PaigerSwap V2 when mainnet MCP trading is enabled."
              : "Every pair listed here is routable through the MPGR Executor, which takes the 0.25% trading fee inside the swap transaction (approve when needed + swap, never a separate fee transaction). Other ERC-20 pairs on Base mainnet use the 0x native-fee path when the operator has enabled mainnet trading.",
          }
        : {}),
    },
  };
}

// ============================================================ quote

export async function getQuote(deps: McpDeps, input: unknown): Promise<ToolOutcome> {
  const args = asRecord(input);
  const chainId = parseChainId(args.chainId ?? BASE_SEPOLIA_CHAIN_ID);
  if (!chainId) return fail("UNSUPPORTED_CHAIN", "chainId must be 84532 (Base Sepolia) or 8453 (Base).");
  if (typeof args.taker !== "string" || !isAddress(args.taker)) return fail("INVALID_TAKER", "taker must be the user's wallet address.");
  const taker = getAddress(args.taker);
  const slippage = parseSlippage(args.slippageBps);
  if (typeof slippage === "string") return fail("INVALID_SLIPPAGE", slippage);

  // ---- Delegated-executor quoting (Phase 3, opt-in) ------------------------
  // The delegated executor has its OWN run-fresh token allowlist and pools;
  // quoting the v1 registry against it would cross-wire two contracts. So the
  // delegated registry is chosen ONLY for an explicit, exact executor match —
  // anything else fails closed. Omitting `executor` keeps the v1 behaviour.
  const executorArg = typeof args.executor === "string" ? args.executor.trim() : "";
  if (executorArg) {
    // The delegated executor exists on BOTH delegated chains (8453 + 84532).
    // The requested address must equal the PINNED executor for THIS chain —
    // on mainnet that is operator-supplied, so an unpinned chain fails closed
    // rather than falling back to the Sepolia contract.
    if (!isDelegatedChainId(chainId)) {
      return fail("UNSUPPORTED_CHAIN", "The delegated executor runs on Base (8453) or Base Sepolia (84532) only.");
    }
    const pinnedExecutor = delegatedExecutorAddressFor(chainId);
    if (!pinnedExecutor) {
      return fail("EXECUTOR_NOT_CONFIGURED", `No delegated executor is pinned for ${delegatedChainLabel(chainId)}.`);
    }
    let requested: Address;
    try {
      requested = getAddress(executorArg);
    } catch {
      return fail("INVALID_EXECUTOR", "executor must be a valid address.");
    }
    if (requested.toLowerCase() !== pinnedExecutor.toLowerCase()) {
      return fail("EXECUTOR_MISMATCH", "executor does not match the pinned delegated executor for this chain.");
    }
    const delegated = deps.delegatedRegistry?.[chainId];
    if (!delegated) {
      return fail("EXECUTOR_NOT_DEPLOYED", "The delegated executor is not registered for quoting.");
    }
    return quoteExecutor(deps, chainId, delegated, args, null, null, taker, slippage);
  }

  // ---- Base mainnet provider dispatch -------------------------------------
  // 1. Operator switch: nothing is quoted on 8453 while mainnet MCP trading
  //    is disabled (MPGR_MCP_ENABLE_BASE_MAINNET unset/false).
  // 2. Registered executor pairs (both tokens in the deployed executor's
  //    allowlist AND a registered route between them — USDC <-> WETH via
  //    Uniswap V3, and USDC <-> each B20 tokenized stock via Aerodrome
  //    Slipstream at tickSpacing 10) quote through the MPGR Executor: live
  //    on-chain fee, quoter, exact floor math, HMAC quoteId, and the 25 bps
  //    fee collected inside the swap transaction.
  // 3. Everything else (an arbitrary ERC-20 pair, WETH <-> B20, B20 <-> B20)
  //    falls through to the 0x native-fee path, which refuses unless the
  //    operator also configured the fee wallet. Nothing is ever routed to the
  //    executor without a registered route, and nothing registered is ever
  //    silently routed fee-less.
  if (chainId === BASE_MAINNET_CHAIN_ID) {
    if (!deps.mainnetEnabled) {
      return fail("BASE_MAINNET_DISABLED", "Base mainnet trading over MCP is disabled. Use chainId 84532 (Base Sepolia).");
    }
    const mainnet = deps.registry[BASE_MAINNET_CHAIN_ID];
    if (mainnet) {
      const sell = resolveToken(mainnet, args.sellToken);
      const buy = resolveToken(mainnet, args.buyToken);
      if (sell && buy && findExecutorRoute(mainnet, sell.token.address, buy.token.address)) {
        return quoteExecutor(deps, BASE_MAINNET_CHAIN_ID, mainnet, args, sell, buy, taker, slippage);
      }
    }
    if (deps.paigerSwapV2?.activated) {
      const v2 = await quotePaigerSwapV2(deps, args, taker, slippage);
      if (v2.ok || !v2.fallThrough) return v2.outcome;
    }
    return quoteZeroEx(deps, args, taker, slippage);
  }

  return quoteExecutor(deps, chainId, deps.registry[chainId] as ExecutorDeployment, args, null, null, taker, slippage);
}

const V2_QUOTE_DEADLINE_SECONDS = 180;

interface ResolvedV2Token {
  address: Address;
  symbol: string;
  decimals: number;
  native: boolean;
}

async function resolveV2Token(deps: McpDeps, raw: unknown): Promise<ResolvedV2Token | { error: string }> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 80) {
    return { error: "Token must be ETH, WETH, USDC, MPGR, or a Base address." };
  }
  if (raw.toUpperCase() === "ETH" || isNativeEthSentinel(raw)) {
    return { address: getAddress(BASE_WETH), symbol: "ETH", decimals: 18, native: true };
  }
  const known = [
    { symbol: "WETH", address: BASE_WETH, decimals: 18 },
    { symbol: "USDC", address: BASE_USDC, decimals: 6 },
    { symbol: "MPGR", address: MPGR_TOKEN_ADDRESS, decimals: 18 },
  ];
  const bySymbol = known.find((token) => token.symbol.toLowerCase() === raw.toLowerCase());
  if (bySymbol) return { address: getAddress(bySymbol.address), symbol: bySymbol.symbol, decimals: bySymbol.decimals, native: false };
  if (!isAddress(raw)) return { error: "Unknown token. Pass ETH, WETH, USDC, MPGR, or a token address." };
  const address = getAddress(raw);
  const pinned = known.find((token) => token.address.toLowerCase() === address.toLowerCase());
  if (pinned) return { address, symbol: pinned.symbol, decimals: pinned.decimals, native: false };
  try {
    const reader = deps.reader(BASE_MAINNET_CHAIN_ID);
    const erc20 = [
      { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
      { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    ] as const;
    const decimals = await reader.readContract({ address, abi: erc20, functionName: "decimals" });
    let symbol = "TOKEN";
    try {
      const read = await reader.readContract({ address, abi: erc20, functionName: "symbol" });
      if (typeof read === "string" && read.length > 0 && read.length <= 32) symbol = read;
    } catch {
      symbol = "TOKEN";
    }
    const n = typeof decimals === "number" ? decimals : Number(decimals);
    if (!Number.isInteger(n) || n < 0 || n > 36) return { error: "Token decimals could not be read. No quote was prepared." };
    return { address, symbol, decimals: n, native: false };
  } catch {
    return { error: "Token metadata could not be read. No quote was prepared." };
  }
}

/**
 * PaigerSwap V2 quote for a pair the legacy executor does not already own.
 * `fallThrough` is true only when V2 proved there is no route, so the existing
 * 0x path can still answer. Simulation and RPC failures do not fall through.
 */
async function quotePaigerSwapV2(
  deps: McpDeps,
  args: Record<string, unknown>,
  taker: Address,
  slippage: number,
): Promise<{ ok: true; outcome: ToolOutcome } | { ok: false; fallThrough: boolean; outcome: ToolOutcome }> {
  const port = deps.paigerSwapV2;
  if (!port?.activated) {
    return { ok: false, fallThrough: true, outcome: fail("V2_NOT_ACTIVATED", "PaigerSwap V2 routing is not activated.") };
  }
  if (port.executor.toLowerCase() !== SWAP_V2_SEALED_MANIFEST.executor.toLowerCase()) {
    return { ok: false, fallThrough: false, outcome: fail("EXECUTOR_MISMATCH", "PaigerSwap V2 is not pinned to the sealed executor. No swap was prepared.") };
  }
  const sell = await resolveV2Token(deps, args.sellToken);
  if ("error" in sell) return { ok: false, fallThrough: false, outcome: fail("TOKEN_NOT_RESOLVED", sell.error) };
  const buy = await resolveV2Token(deps, args.buyToken);
  if ("error" in buy) return { ok: false, fallThrough: false, outcome: fail("TOKEN_NOT_RESOLVED", buy.error) };
  if (sell.address.toLowerCase() === buy.address.toLowerCase()) {
    return { ok: false, fallThrough: false, outcome: fail("INVALID_PAIR", "Sell and buy tokens must differ. ETH and WETH are the same asset.") };
  }
  const amount = parseSellAmount(args, sell.decimals);
  if (typeof amount === "string") return { ok: false, fallThrough: false, outcome: fail("INVALID_AMOUNT", amount) };
  const fee = (amount * 25n) / 10_000n;
  if (fee <= 0n || fee >= amount) {
    return { ok: false, fallThrough: false, outcome: fail("FEE_ROUNDS_TO_ZERO", "Sell amount is too small to collect the 0.25% trading fee exactly once.") };
  }
  const now = deps.nowSeconds();
  const deadline = BigInt(now + V2_QUOTE_DEADLINE_SECONDS);
  let quoted;
  try {
    quoted = await port.quote({
      sellToken: sell.address,
      buyToken: buy.address,
      gross: amount,
      taker,
      slippageBps: slippage,
      nativeIn: sell.native,
      nativeOut: buy.native,
      deadline,
    });
  } catch {
    return { ok: false, fallThrough: false, outcome: fail("EXECUTION_UNAVAILABLE", "PaigerSwap V2 quoting failed. No swap was prepared.") };
  }
  if (!quoted.ok) return { ok: false, fallThrough: quoted.fallThrough, outcome: fail(quoted.code, quoted.message) };
  if (quoted.fee !== fee) {
    return { ok: false, fallThrough: false, outcome: fail("FEE_POLICY_INVALID", "PaigerSwap V2 fee was not floor(sellAmount * 25 / 10000) once on the gross sell amount.") };
  }
  if (quoted.amountOut <= 0n) {
    return { ok: false, fallThrough: false, outcome: fail("QUOTE_FAILED", "PaigerSwap V2 returned no usable output. No swap was prepared.") };
  }
  const minBuy = (quoted.amountOut * BigInt(10_000 - slippage)) / 10_000n;
  if (minBuy <= 0n || BigInt(quoted.binding.minBuyAmount) !== minBuy) {
    return { ok: false, fallThrough: false, outcome: fail("QUOTE_FAILED", "PaigerSwap V2 minimum output does not match the requested slippage.") };
  }
  if (quoted.binding.executor.toLowerCase() !== port.executor.toLowerCase() || quoted.binding.deadline !== deadline.toString()) {
    return { ok: false, fallThrough: false, outcome: fail("EXECUTION_UNAVAILABLE", "PaigerSwap V2 returned a transaction that is not bound to this quote.") };
  }
  const inspected = inspectPaigerSwapV2Binding(quoted.binding, {
    taker,
    sellToken: sell.address,
    buyToken: buy.address,
    nativeIn: sell.native,
    nativeOut: buy.native,
    gross: amount,
    fee,
    minBuyAmount: minBuy,
  });
  if (!inspected.ok) {
    return { ok: false, fallThrough: false, outcome: fail("EXECUTION_UNAVAILABLE", `PaigerSwap V2 calldata was rejected: ${inspected.reason}`) };
  }
  const reader = deps.reader(BASE_MAINNET_CHAIN_ID);
  const balance = sell.native ? await reader.getBalance({ address: taker }) : await readTokenBalance(reader, sell.address, taker);
  const payload: QuotePayload = {
    v: 1,
    chainId: BASE_MAINNET_CHAIN_ID,
    provider: "paigerswap-v2",
    taker,
    sellToken: sell.address,
    buyToken: buy.address,
    sellNative: sell.native,
    buyNative: buy.native,
    sellAmount: amount.toString(),
    expectedBuyAmount: quoted.amountOut.toString(),
    slippageBps: slippage,
    feeBps: 25,
    feeAmount: fee.toString(),
    feeRecipient: V2_FEE_RECIPIENT,
    iat: now,
    exp: now + QUOTE_TTL_SECONDS,
    v2: quoted.binding as unknown as Record<string, unknown>,
  };
  const signed = signQuoteId(payload, deps.quoteSecret);
  if (!signed.ok) return { ok: false, fallThrough: false, outcome: fail(signed.error.code, signed.error.message) };
  return {
    ok: true,
    outcome: {
      ok: true,
      data: paigerSwapV2QuoteView({
        quoteId: signed.quoteId,
        payload,
        binding: quoted.binding,
        sell,
        buy,
        balance,
        priceImpactBps: quoted.priceImpactBps,
      }),
    },
  };
}

/**
 * Verify the route's module against the executor's live registry and actual
 * runtime bytecode. A TypeScript route entry alone is never enough to authorize
 * a module call.
 */
async function typedModulePostureMatches(reader: ChainReader, executor: Address, route: ExecutorRoute): Promise<boolean> {
  if (route.kind !== RouterKind.TYPED_SWAP_MODULE || !route.moduleAddress || !route.moduleCodeHash) return false;
  if (!/^0x[0-9a-fA-F]{64}$/.test(route.moduleCodeHash) || !reader.getBytecode) return false;
  try {
    const [kind, module, codeHash, bytecode] = await Promise.all([
      reader.readContract({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "routerKind", args: [route.router] }),
      reader.readContract({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "swapModuleForRouter", args: [route.router] }),
      reader.readContract({ address: executor, abi: DELEGATED_EXECUTOR_ABI, functionName: "swapModuleCodeHash", args: [route.router] }),
      reader.getBytecode({ address: route.moduleAddress }),
    ]);
    return Number(kind) === RouterKind.TYPED_SWAP_MODULE
      && String(module).toLowerCase() === route.moduleAddress.toLowerCase()
      && String(codeHash).toLowerCase() === route.moduleCodeHash.toLowerCase()
      && Boolean(bytecode && bytecode !== "0x" && keccak256(bytecode).toLowerCase() === route.moduleCodeHash.toLowerCase());
  } catch {
    return false;
  }
}

/** Executor-path quote, shared by Base Sepolia and the proven Base mainnet route. */
async function quoteExecutor(
  deps: McpDeps,
  chainId: ExecutorChainId,
  d: ExecutorDeployment,
  args: Record<string, unknown>,
  sell: { token: ExecutorToken; native: boolean } | null,
  buy: { token: ExecutorToken; native: boolean } | null,
  taker: Address,
  slippage: number,
): Promise<ToolOutcome> {
  if (!d) return fail("EXECUTOR_NOT_DEPLOYED", "The MPGR Executor is not yet deployed on Base Sepolia.");
  if (!sell) sell = resolveToken(d, args.sellToken);
  if (!buy) buy = resolveToken(d, args.buyToken);
  if (!sell) return fail("TOKEN_NOT_ALLOWED", "sellToken is not in the executor allowlist (see mpgr_list_tokens).");
  if (!buy) return fail("TOKEN_NOT_ALLOWED", "buyToken is not in the executor allowlist (see mpgr_list_tokens).");
  const amount = parseSellAmount(args, sell.token.decimals);
  if (typeof amount === "string") return fail("INVALID_AMOUNT", amount);

  const reader = deps.reader(chainId);
  const live = await readExecutorLiveConfig(reader, d.executor);
  if (live.paused) return fail("EXECUTOR_PAUSED", "The executor is paused by its owner. Try again later.");
  const fee = computeExecutorFee(amount, live.feeBps);
  if (!fee.ok) return fail(fee.error.code, fee.error.message);

  const route = findExecutorRoute(d, sell.token.address, buy.token.address);
  if (!route) return fail("NO_ROUTE", "No allowlisted route for this pair.");
  const isExplicitDelegatedQuote =
    typeof args.executor === "string" && isAddress(args.executor) && getAddress(args.executor).toLowerCase() === d.executor.toLowerCase();
  if (route.kind === RouterKind.TYPED_SWAP_MODULE && !isExplicitDelegatedQuote) {
    return fail("INVALID_VENUE", "Typed swap modules are supported only through the explicitly pinned delegated executor.");
  }
  if (route.kind === RouterKind.TYPED_SWAP_MODULE && (sell.native || buy.native)) {
    return fail("NATIVE_UNSUPPORTED_FOR_MODULE", "Typed-module routes currently support ERC-20 token pairs only.");
  }
  let expected: bigint;
  try {
    if (route.kind === RouterKind.TYPED_SWAP_MODULE) {
      if (!route.moduleAddress || !route.moduleCodeHash) {
        return fail("INVALID_VENUE", "Typed-module quote requires a pinned module address and code hash.");
      }
      if (!(await typedModulePostureMatches(reader, d.executor, route))) {
        return fail("ROUTE_MISMATCH", "Typed-module quote does not match the executor's live module registration and bytecode.");
      }
      const { result } = await reader.simulateContract({
        address: route.moduleAddress,
        abi: DELEGATED_SWAP_MODULE_ABI,
        functionName: "quoteExactInput",
        args: [sell.token.address, buy.token.address, fee.value.swapAmountIn],
      });
      expected = result as bigint;
    } else if (route.kind === RouterKind.UNISWAP_V3_ROUTER02) {
      if (!route.quoter || route.poolFee === undefined) return fail("INVALID_VENUE", "Uniswap V3 route is missing its quoter or poolFee.");
      expected = await quoteUniswapV3(reader, route.quoter, sell.token.address, buy.token.address, fee.value.swapAmountIn, route.poolFee);
    } else {
      if (!route.quoter || route.tickSpacing === undefined) return fail("INVALID_VENUE", "Slipstream route is missing its quoter or tickSpacing.");
      expected = await quoteSlipstream(reader, route.quoter, sell.token.address, buy.token.address, fee.value.swapAmountIn, route.tickSpacing);
    }
  } catch {
    return fail("QUOTE_FAILED", "The on-chain quoter could not price this trade (insufficient liquidity?).");
  }
  // Defense-in-depth: a structurally unusable quote must fail CLOSED as a
  // structured QUOTE_FAILED (goal stays ACTIVE, nothing broadcast) instead of
  // crashing later at `expectedBuyAmount: expected.toString()`.
  if (typeof expected !== "bigint" || expected <= 0n)
    return fail("QUOTE_FAILED", "Quoter returned no usable output amount.");

  const now = deps.nowSeconds();
  const payload: QuotePayload = {
    v: 1,
    chainId,
    provider: "mpgr-executor",
    taker,
    sellToken: sell.token.address,
    buyToken: buy.token.address,
    sellNative: sell.native,
    buyNative: buy.native,
    sellAmount: amount.toString(),
    expectedBuyAmount: expected.toString(),
    slippageBps: slippage,
    feeBps: live.feeBps,
    feeAmount: fee.value.feeAmount.toString(),
    feeRecipient: live.feeRecipient,
    iat: now,
    exp: now + QUOTE_TTL_SECONDS,
  };
  const signed = signQuoteId(payload, deps.quoteSecret);
  if (!signed.ok) return fail(signed.error.code, signed.error.message);

  if (route.kind === RouterKind.TYPED_SWAP_MODULE) {
    const balance = await readTokenBalance(reader, sell.token.address, taker);
    const minBuyAmount = (expected * BigInt(10_000 - slippage)) / 10_000n;
    return {
      ok: true,
      data: {
        quoteId: signed.quoteId,
        chainId,
        taker,
        recipient: taker,
        sellToken: tokenView(sell.token),
        buyToken: tokenView(buy.token),
        sellNative: false,
        buyNative: false,
        sellAmount: amount.toString(),
        sellAmountHuman: formatUnits(amount, sell.token.decimals),
        expectedBuyAmount: expected.toString(),
        expectedBuyAmountHuman: formatUnits(expected, buy.token.decimals),
        minBuyAmount: minBuyAmount.toString(),
        minBuyAmountHuman: formatUnits(minBuyAmount, buy.token.decimals),
        slippageBps: slippage,
        feeBps: live.feeBps,
        feeAmount: fee.value.feeAmount.toString(),
        feeAmountHuman: formatUnits(fee.value.feeAmount, sell.token.decimals),
        feeToken: sell.token.address,
        feeRecipient: live.feeRecipient,
        feeCollection: "same-transaction (delegated executor, on-chain, exact)",
        swapAmount: fee.value.swapAmountIn.toString(),
        route: {
          provider: "mpgr-executor",
          venue: "typed-swap-module",
          executor: d.executor,
          router: route.router,
          moduleAddress: route.moduleAddress,
          moduleCodeHash: route.moduleCodeHash,
          hops: 1,
        },
        executor: d.executor,
        spender: d.executor,
        authorization: "PERMIT2",
        deadline: now + INTENT_TTL_SECONDS,
        expiresAt: payload.exp,
        balanceSufficient: balance >= amount,
        takerBalance: balance.toString(),
        nextStep: "Use the delegated authorization slot; the user's wallet signs and the operator never signs for the user.",
      },
    };
  }

  const built = intentFromPayload(d, payload, signed.quoteId, "APPROVAL");
  if (!built.ok) return built;
  const balance = sell.native ? await reader.getBalance({ address: taker }) : await readTokenBalance(reader, sell.token.address, taker);
  return {
    ok: true,
    data: {
      ...intentView(built.intent, signed.quoteId),
      provider: "mpgr-executor",
      expiresAt: payload.exp,
      balanceSufficient: balance >= amount,
      takerBalance: balance.toString(),
      nextStep: "Call mpgr_prepare_trade with this quoteId and authorization APPROVAL | EIP2612 | PERMIT2.",
    },
  };
}

function intentFromPayload(
  d: ExecutorDeployment,
  p: QuotePayload,
  quoteId: string,
  authorization: AuthorizationMode,
): { ok: true; intent: ExecutorSwapIntent } | { ok: false; error: { code: string; message: string } } {
  const r = buildExecutorIntent({
    deployment: d,
    taker: p.taker,
    sellToken: p.sellToken,
    buyToken: p.buyToken,
    sellNative: p.sellNative,
    buyNative: p.buyNative,
    sellAmount: BigInt(p.sellAmount),
    expectedBuyAmount: BigInt(p.expectedBuyAmount),
    slippageBps: p.slippageBps,
    authorization,
    nowSeconds: p.iat,
    deadlineSeconds: INTENT_TTL_SECONDS,
    quoteId,
    feeBps: p.feeBps,
    feeRecipient: p.feeRecipient,
  });
  if (!r.ok) return r;
  if (r.value.feeAmount !== p.feeAmount) return { ok: false, error: { code: "FEE_MISMATCH", message: "Fee does not match the quote." } };
  return { ok: true, intent: r.value };
}

function parseAuthorization(raw: unknown): AuthorizationMode | null {
  return raw === "APPROVAL" || raw === "EIP2612" || raw === "PERMIT2" ? raw : null;
}

async function preparePaigerSwapV2(
  deps: McpDeps,
  p: QuotePayload,
  quoteId: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const port = deps.paigerSwapV2;
  if (!port?.activated) return fail("V2_NOT_ACTIVATED", "PaigerSwap V2 routing is not activated. Request a fresh quote. Nothing was sent.");
  const authorization = parseAuthorization(args.authorization ?? "APPROVAL");
  if (authorization !== "APPROVAL") {
    return fail("INVALID_AUTHORIZATION", "PaigerSwap V2 requires authorization APPROVAL. Permit modes are not used on this executor. Nothing was sent.");
  }
  if (p.chainId !== BASE_MAINNET_CHAIN_ID) return fail("UNSUPPORTED_CHAIN", "PaigerSwap V2 is Base mainnet only.");
  if (p.feeBps !== 25 || p.feeRecipient.toLowerCase() !== V2_FEE_RECIPIENT.toLowerCase()) {
    return fail("FEE_POLICY_INVALID", "Quote fee does not match the pinned 0.25% trading fee.");
  }
  const binding = parsePaigerSwapV2Binding(p.v2);
  if (!binding) return fail("QUOTE_ID_INVALID", "Quote is missing its PaigerSwap V2 transaction binding.");
  const gross = BigInt(p.sellAmount);
  const fee = (gross * 25n) / 10_000n;
  if (p.feeAmount !== fee.toString()) return fail("FEE_MISMATCH", "Fee does not match the quote.");
  if (deps.nowSeconds() > Number(binding.deadline)) return fail("QUOTE_EXPIRED", "The V2 deadline passed. Request a fresh quote. Nothing was sent.");
  const taker = getAddress(p.taker);
  const sell = getAddress(p.sellToken);
  const buy = getAddress(p.buyToken);
  const inspected = inspectPaigerSwapV2Binding(binding, {
    taker, sellToken: sell, buyToken: buy, nativeIn: p.sellNative, nativeOut: p.buyNative,
    gross, fee, minBuyAmount: BigInt(binding.minBuyAmount),
  });
  if (!inspected.ok) return fail("EXECUTION_UNAVAILABLE", `PaigerSwap V2 calldata was rejected: ${inspected.reason}`);
  let confirmed;
  try {
    confirmed = await port.confirm(binding, taker);
  } catch {
    return fail("EXECUTION_UNAVAILABLE", "PaigerSwap V2 could not re-check this quote. Nothing was sent.");
  }
  if (!confirmed.ok) return fail(confirmed.code, confirmed.message);
  const reader = deps.reader(BASE_MAINNET_CHAIN_ID);
  const balance = p.sellNative ? await reader.getBalance({ address: taker }) : await readTokenBalance(reader, sell, taker);
  if (balance < gross) return fail("INSUFFICIENT_BALANCE", `Taker balance ${balance.toString()} < sellAmount ${gross.toString()}.`);
  const steps: Record<string, unknown>[] = [];
  const transactionRequest = {
    chainId: BASE_MAINNET_CHAIN_ID,
    to: binding.transaction.to,
    data: binding.transaction.data,
    value: binding.transaction.value,
  };
  if (!p.sellNative) {
    const allowance = await readAllowance(reader, sell, taker, binding.executor);
    if (allowance < gross) {
      steps.push({
        step: "sendApprovalTransaction",
        who: "user wallet",
        description: `Approve the PaigerSwap V2 executor to spend exactly ${p.sellAmount} of the sell token (not unlimited).`,
        transactionRequest: encodeExactApproval(BASE_MAINNET_CHAIN_ID, sell, binding.executor, gross),
      });
    }
  }
  steps.push({ step: "sendSwapTransaction", who: "user wallet", afterPreviousStepConfirmed: steps.length > 0, transactionRequest });
  return {
    ok: true,
    data: {
      provider: "paigerswap-v2",
      quoteId,
      executor: binding.executor,
      spender: binding.executor,
      chainId: BASE_MAINNET_CHAIN_ID,
      steps,
      transactionRequest,
      typedData: null,
      permit: null,
      expiresAt: Number(binding.deadline),
      feeBps: 25,
      feeAmount: p.feeAmount,
      feeRecipient: p.feeRecipient,
      minBuyAmount: binding.minBuyAmount,
      expectedBuyAmount: p.expectedBuyAmount,
      sellAmount: p.sellAmount,
      recipient: taker,
      route: {
        provider: "paigerswap-v2",
        entry: binding.entry,
        hops: binding.hops,
        pools: binding.pools,
        executionSimulation: binding.executionSimulation,
      },
      safety: "Unsigned data only. Review in your wallet before sending: `to` must be the PaigerSwap V2 executor, the recipient must be your own address, and this server never signs or broadcasts.",
    },
  };
}

// ============================================================ prepare

export async function prepareTrade(deps: McpDeps, input: unknown): Promise<ToolOutcome> {
  const args = asRecord(input);
  const now = deps.nowSeconds();
  const v = verifyQuoteId(args.quoteId, now, deps.quoteSecret);
  if (!v.ok) return fail(v.error.code, v.error.message);
  const p = v.payload;
  const quoteId = args.quoteId as string;
  if (p.provider === "0x-native-fee") return prepareZeroEx(deps, p, quoteId);
  if (p.provider === "paigerswap-v2") return preparePaigerSwapV2(deps, p, quoteId, args);

  const authorization = parseAuthorization(args.authorization ?? "APPROVAL");
  if (!authorization) return fail("INVALID_AUTHORIZATION", "authorization must be APPROVAL, EIP2612 or PERMIT2.");
  const chainId = p.chainId as ExecutorChainId;
  const d = deps.registry[chainId];
  if (!d) return fail("EXECUTOR_NOT_DEPLOYED", "Executor not deployed on this chain.");
  const reader = deps.reader(chainId);

  const live = await readExecutorLiveConfig(reader, d.executor);
  if (live.paused) return fail("EXECUTOR_PAUSED", "The executor is paused by its owner.");
  if (live.feeBps !== p.feeBps || live.feeRecipient.toLowerCase() !== p.feeRecipient.toLowerCase()) {
    return fail("QUOTE_STALE", "Executor fee configuration changed since the quote. Request a new quote.");
  }
  const built = intentFromPayload(d, p, quoteId, authorization);
  if (!built.ok) return built;
  const intent = built.intent;
  const gross = BigInt(intent.sellAmount);

  const balance = intent.sellNative
    ? await reader.getBalance({ address: intent.taker })
    : await readTokenBalance(reader, intent.sellToken.address, intent.taker);
  if (balance < gross) {
    return fail("INSUFFICIENT_BALANCE", `Taker balance ${balance.toString()} < sellAmount ${gross.toString()}.`);
  }

  const steps: Record<string, unknown>[] = [];
  let transactionRequest: UnsignedTransactionRequest | null = null;
  let typedData: unknown = null;
  let permit: { nonce: string; deadline: number } | null = null;

  if (intent.sellNative) {
    transactionRequest = encodeExecutorSwap(intent, approvalAuthorization());
    steps.push({ step: "sendSwapTransaction", who: "user wallet", transactionRequest });
  } else if (authorization === "APPROVAL") {
    const allowance = await readAllowance(reader, intent.sellToken.address, intent.taker, intent.executor);
    if (allowance < gross) {
      steps.push({
        step: "sendApprovalTransaction",
        who: "user wallet",
        description: `Approve the MPGR Executor to spend exactly ${intent.sellAmount} ${intent.sellToken.symbol} (not unlimited).`,
        transactionRequest: encodeExactApproval(chainId, intent.sellToken.address, intent.executor, gross),
      });
    }
    transactionRequest = encodeExecutorSwap(intent, approvalAuthorization());
    steps.push({ step: "sendSwapTransaction", who: "user wallet", afterPreviousStepConfirmed: steps.length > 0, transactionRequest });
  } else if (authorization === "EIP2612") {
    const domain = await readEip712Domain(reader, intent.sellToken.address);
    if (!domain) return fail("EIP2612_UNSUPPORTED", `${intent.sellToken.symbol} does not expose EIP-2612/EIP-5267; use APPROVAL or PERMIT2.`);
    const nonce = await readPermitNonce(reader, intent.sellToken.address, intent.taker);
    typedData = buildEip2612TypedData(intent, domain, nonce, intent.deadline);
    permit = { nonce: nonce.toString(), deadline: intent.deadline };
    steps.push({ step: "signTypedData", who: "user wallet", method: "eth_signTypedData_v4", typedData: jsonSafe(typedData) });
    steps.push({ step: "callTool", tool: "mpgr_finalize_trade", args: { quoteId, authorization, permitNonce: permit.nonce, signature: "<user signature>" } });
  } else {
    const allowance = await readAllowance(reader, intent.sellToken.address, intent.taker, d.permit2);
    if (allowance < gross) {
      steps.push({
        step: "sendApprovalTransaction",
        who: "user wallet",
        description: `Approve Permit2 to spend exactly ${intent.sellAmount} ${intent.sellToken.symbol}.`,
        transactionRequest: encodeExactApproval(chainId, intent.sellToken.address, d.permit2, gross),
      });
    }
    const nonce = await pickUnusedPermit2Nonce(reader, d.permit2, intent.taker);
    typedData = buildPermit2TypedData(intent, d.permit2, nonce, intent.deadline);
    permit = { nonce: nonce.toString(), deadline: intent.deadline };
    steps.push({ step: "signTypedData", who: "user wallet", method: "eth_signTypedData_v4", typedData: jsonSafe(typedData) });
    steps.push({ step: "callTool", tool: "mpgr_finalize_trade", args: { quoteId, authorization, permitNonce: permit.nonce, signature: "<user signature>" } });
  }

  return {
    ok: true,
    data: {
      intent: intentView(intent, quoteId),
      steps,
      transactionRequest,
      typedData: typedData ? jsonSafe(typedData) : null,
      permit,
      expiresAt: intent.deadline,
      safety: "Unsigned data only. Review in your wallet: `to` must be the MPGR Executor, recipient must be your own address.",
    },
  };
}

// ============================================================ finalize (permit modes)

export async function finalizeTrade(deps: McpDeps, input: unknown): Promise<ToolOutcome> {
  const args = asRecord(input);
  const now = deps.nowSeconds();
  // Signing may take longer than the quote TTL: accept until the intent deadline.
  const v = verifyQuoteId(args.quoteId, Math.min(now, now - (INTENT_TTL_SECONDS - QUOTE_TTL_SECONDS)), deps.quoteSecret);
  if (!v.ok) return fail(v.error.code, v.error.message);
  const p = v.payload;
  if (now > p.iat + INTENT_TTL_SECONDS) return fail("QUOTE_EXPIRED", "Intent deadline passed. Request a new quote.");
  if (p.provider === "paigerswap-v2") {
    return fail("NOT_APPLICABLE", "PaigerSwap V2 does not use permit finalization. Call mpgr_prepare_trade with authorization APPROVAL, then send that unsigned transaction from your wallet.");
  }
  if (p.provider !== "mpgr-executor") return fail("NOT_APPLICABLE", "finalize is only used for executor permit modes.");
  const authorization = parseAuthorization(args.authorization);
  if (authorization !== "EIP2612" && authorization !== "PERMIT2") {
    return fail("INVALID_AUTHORIZATION", "finalize requires authorization EIP2612 or PERMIT2.");
  }
  if (typeof args.signature !== "string" || !isHex(args.signature) || args.signature.length !== 132) {
    return fail("INVALID_SIGNATURE", "signature must be a 65-byte 0x-hex string from the user's wallet.");
  }
  if (typeof args.permitNonce !== "string" || !/^\d{1,78}$/.test(args.permitNonce)) {
    return fail("INVALID_NONCE", "permitNonce (decimal string from mpgr_prepare_trade) is required.");
  }
  const chainId = p.chainId as ExecutorChainId;
  const d = deps.registry[chainId];
  if (!d) return fail("EXECUTOR_NOT_DEPLOYED", "Executor not deployed on this chain.");
  const reader = deps.reader(chainId);
  const quoteId = args.quoteId as string;
  const built = intentFromPayload(d, p, quoteId, authorization);
  if (!built.ok) return built;
  const intent = built.intent;
  const nonce = BigInt(args.permitNonce);
  const signature = args.signature as Hex;

  let typedData;
  if (authorization === "EIP2612") {
    const domain = await readEip712Domain(reader, intent.sellToken.address);
    if (!domain) return fail("EIP2612_UNSUPPORTED", "Token does not support EIP-2612.");
    const current = await readPermitNonce(reader, intent.sellToken.address, intent.taker);
    if (current !== nonce) return fail("PERMIT_NONCE_STALE", "Permit nonce changed. Call mpgr_prepare_trade again.");
    typedData = buildEip2612TypedData(intent, domain, nonce, intent.deadline);
  } else {
    typedData = buildPermit2TypedData(intent, d.permit2, nonce, intent.deadline);
  }
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...(typedData as unknown as Parameters<typeof recoverTypedDataAddress>[0]), signature });
  } catch {
    return fail("INVALID_SIGNATURE", "Signature could not be recovered.");
  }
  if (signer.toLowerCase() !== intent.taker.toLowerCase()) {
    return fail("SIGNATURE_MISMATCH", "Signature was not produced by the taker for this exact intent.");
  }
  const auth = authorizationFromSignature(authorization, signature, nonce, intent.deadline);
  if (!auth.ok) return fail(auth.error.code, auth.error.message);
  const transactionRequest = encodeExecutorSwap(intent, auth.value);
  return {
    ok: true,
    data: {
      intent: intentView(intent, quoteId),
      transactionRequest,
      steps: [{ step: "sendSwapTransaction", who: "user wallet", transactionRequest }],
      expiresAt: intent.deadline,
    },
  };
}

// ============================================================ status / verify

export async function getTradeStatus(deps: McpDeps, input: unknown): Promise<ToolOutcome> {
  const args = asRecord(input);
  const chainId = parseChainId(args.chainId ?? BASE_SEPOLIA_CHAIN_ID);
  if (!chainId) return fail("UNSUPPORTED_CHAIN", "chainId must be 84532 or 8453.");
  if (typeof args.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) return fail("INVALID_TX_HASH", "txHash must be a 32-byte hex hash.");
  try {
    const r = await deps.reader(chainId).getTransactionReceipt({ hash: args.txHash as Hex });
    return {
      ok: true,
      data: {
        chainId,
        txHash: r.transactionHash,
        status: r.status === "success" ? "confirmed" : "reverted",
        blockNumber: r.blockNumber.toString(),
        explorerUrl: `${EXECUTOR_EXPLORERS[chainId]}/tx/${r.transactionHash}`,
      },
    };
  } catch {
    return { ok: true, data: { chainId, txHash: args.txHash, status: "pending_or_unknown" } };
  }
}

export async function verifyTrade(deps: McpDeps, input: unknown): Promise<ToolOutcome> {
  const args = asRecord(input);
  // Verification is valid long after expiry: only the MAC matters here (30-day window).
  const v = verifyQuoteId(args.quoteId, deps.nowSeconds() - 30 * 24 * 3600, deps.quoteSecret);
  if (!v.ok) return fail(v.error.code, v.error.message);
  const p = v.payload;
  if (typeof args.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) return fail("INVALID_TX_HASH", "txHash must be a 32-byte hex hash.");
  const chainId = p.chainId as ExecutorChainId;
  const reader = deps.reader(chainId);
  let receipt;
  try {
    receipt = await reader.getTransactionReceipt({ hash: args.txHash as Hex });
  } catch {
    return fail("TX_NOT_FOUND", "Transaction receipt not found yet. Retry after it is mined.");
  }

  if (p.provider === "0x-native-fee") return verifyZeroExReceipt(p, receipt);
  if (p.provider === "paigerswap-v2") {
    const checked = verifyPaigerSwapV2Trade(p, receipt);
    return {
      ok: true,
      data: jsonSafe({
        verified: checked.verified,
        reason: checked.reason,
        provider: "paigerswap-v2",
        executor: SWAP_V2_SEALED_MANIFEST.executor,
        chainId: p.chainId,
        amountIn: checked.settlement?.amountIn ?? null,
        amountOut: checked.settlement?.amountOut ?? null,
        feeAmount: checked.settlement?.feeAmount ?? null,
        feeBps: checked.settlement?.feeBps ?? null,
        feeRecipient: checked.settlement?.feeRecipient ?? null,
        explorerUrl: `${EXECUTOR_EXPLORERS[chainId]}/tx/${receipt.transactionHash}`,
      }) as Record<string, unknown>,
    };
  }

  const defaultDeployment = deps.registry[chainId];
  if (!defaultDeployment) return fail("EXECUTOR_NOT_DEPLOYED", "Executor not deployed on this chain.");
  // Phase 3: select the verification registry by FACT — the receipt's
  // executed contract. A trade the delegated executor executed is verified
  // against the delegated registry (its own token allowlist/routes); every
  // other trade keeps the v1 default. Fail-closed: an unknown executor fails
  // the executor checks downstream, never passes by heuristic.
  const delegatedDeployment = deps.delegatedRegistry?.[chainId];
  const executedTo = typeof receipt.to === "string" ? getAddress(receipt.to) : null;
  const d = delegatedDeployment && executedTo !== null && executedTo === delegatedDeployment.executor ? delegatedDeployment : defaultDeployment;
  const built = intentFromPayload(d, p, args.quoteId as string, "APPROVAL");
  if (!built.ok) return built;
  if (typeof args.expectedSender === "string" && isAddress(args.expectedSender)) {
    // Delegated path ONLY (additive): verification is scoped to the explicit
    // expectedSender; the event taker check remains the owner binding.
    built.intent.expectedSender = getAddress(args.expectedSender);
  }
  if (typeof args.expectedIntentId === "string") {
    // Delegated path ONLY: the executor REQUIRES call intentId == the signed
    // witness actionId (contract line: p.intentId != auth.witness.actionId ->
    // InvalidWitness), so the event carries the actionId, never the quote-
    // derived id. The caller pins it explicitly; the event check stays strict.
    if (!/^0x[0-9a-fA-F]{64}$/.test(args.expectedIntentId)) return fail("INVALID_INTENT_ID", "expectedIntentId must be a 32-byte hex hash.");
    built.intent.intentId = args.expectedIntentId as `0x${string}`;
  }
  const result = verifyExecutorReceipt(receipt, built.intent);
  return { ok: true, data: jsonSafe({ ...result, explorerUrl: `${EXECUTOR_EXPLORERS[chainId]}/tx/${receipt.transactionHash}` }) as Record<string, unknown> };
}

// ============================================================ 0x (Base mainnet, gated)

const ERC20_TRANSFER_EVENT = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

async function quoteZeroEx(deps: McpDeps, args: Record<string, unknown>, taker: Address, slippage: number): Promise<ToolOutcome> {
  if (!deps.mainnetEnabled) {
    return fail("BASE_MAINNET_DISABLED", "Base mainnet trading over MCP is disabled. Use chainId 84532 (Base Sepolia).");
  }
  if (!deps.mainnetFeeRecipient) return fail("FEE_RECIPIENT_NOT_CONFIGURED", "MPGR fee wallet is not configured; refusing (the fee is never skipped).");
  if (typeof args.sellToken !== "string" || !isAddress(args.sellToken) || typeof args.buyToken !== "string" || !isAddress(args.buyToken)) {
    return fail("INVALID_TOKEN", "On Base mainnet, sellToken and buyToken must be ERC-20 addresses (native ETH sells are not offered over MCP).");
  }
  if (typeof args.sellAmount !== "string" || !/^\d{1,78}$/.test(args.sellAmount)) {
    return fail("INVALID_AMOUNT", "On Base mainnet, sellAmount (base units) is required.");
  }
  const sellToken = getAddress(args.sellToken);
  const buyToken = getAddress(args.buyToken);
  const sellAmount = BigInt(args.sellAmount);
  const q = await getZeroExNativeFeeQuote(
    { sellToken, buyToken, sellAmount, taker, slippageBps: slippage, feeRecipient: deps.mainnetFeeRecipient },
    deps.zeroExFetch,
  );
  if (!q.ok) return fail(q.error.code, q.error.message);
  const now = deps.nowSeconds();
  const payload: QuotePayload = {
    v: 1,
    chainId: BASE_MAINNET_CHAIN_ID,
    provider: "0x-native-fee",
    taker,
    sellToken,
    buyToken,
    sellNative: false,
    buyNative: false,
    sellAmount: q.value.sellAmount,
    expectedBuyAmount: q.value.buyAmount,
    slippageBps: slippage,
    feeBps: q.value.feeBps,
    feeAmount: q.value.feeAmount,
    feeRecipient: q.value.feeRecipient,
    iat: now,
    exp: now + QUOTE_TTL_SECONDS,
  };
  const signed = signQuoteId(payload, deps.quoteSecret);
  if (!signed.ok) return fail(signed.error.code, signed.error.message);
  return {
    ok: true,
    data: { ...zeroExView(q.value, signed.quoteId), provider: "0x-native-fee", expiresAt: payload.exp, nextStep: "Call mpgr_prepare_trade with this quoteId." },
  };
}

function zeroExView(q: ZeroExNativeFeeQuote, quoteId: string) {
  return {
    quoteId,
    chainId: q.chainId,
    sellToken: q.sellToken,
    buyToken: q.buyToken,
    sellAmount: q.sellAmount,
    expectedBuyAmount: q.buyAmount,
    minBuyAmount: q.minBuyAmount,
    feeBps: q.feeBps,
    feeAmount: q.feeAmount,
    feeToken: q.feeToken,
    feeRecipient: q.feeRecipient,
    feeCollection: "same-transaction (0x native integrator fee, verified exact)",
    route: { provider: "0x-native-fee", fills: q.route },
    spender: q.spender,
  };
}

async function prepareZeroEx(deps: McpDeps, p: QuotePayload, quoteId: string): Promise<ToolOutcome> {
  if (!deps.mainnetEnabled || !deps.mainnetFeeRecipient) return fail("BASE_MAINNET_DISABLED", "Base mainnet trading over MCP is disabled.");
  // 0x calldata must be fresh: re-quote with the SAME bound parameters and re-validate the exact fee.
  const q = await getZeroExNativeFeeQuote(
    {
      sellToken: p.sellToken as Address,
      buyToken: p.buyToken as Address,
      sellAmount: BigInt(p.sellAmount),
      taker: p.taker as Address,
      slippageBps: p.slippageBps,
      feeRecipient: p.feeRecipient as Address,
    },
    deps.zeroExFetch,
  );
  if (!q.ok) return fail(q.error.code, q.error.message);
  const floor = (BigInt(p.expectedBuyAmount) * BigInt(10_000 - p.slippageBps)) / 10_000n;
  if (BigInt(q.value.minBuyAmount) < floor) return fail("QUOTE_STALE", "Price moved beyond slippage since the quote. Request a new quote.");
  const reader = deps.reader(BASE_MAINNET_CHAIN_ID);
  const allowance = await readAllowance(reader, q.value.sellToken, p.taker as Address, ZERO_EX_ALLOWANCE_HOLDER_BASE);
  const steps: Record<string, unknown>[] = [];
  if (allowance < BigInt(p.sellAmount)) {
    steps.push({
      step: "sendApprovalTransaction",
      who: "user wallet",
      description: "Approve the 0x AllowanceHolder for exactly the sell amount (never approve Settler).",
      transactionRequest: encodeExactApproval(BASE_MAINNET_CHAIN_ID, q.value.sellToken, ZERO_EX_ALLOWANCE_HOLDER_BASE, BigInt(p.sellAmount)),
    });
  }
  const transactionRequest = { chainId: BASE_MAINNET_CHAIN_ID, ...q.value.transaction };
  steps.push({ step: "sendSwapTransaction", who: "user wallet", transactionRequest });
  return { ok: true, data: { intent: zeroExView(q.value, quoteId), steps, transactionRequest, expiresAt: p.iat + INTENT_TTL_SECONDS } };
}

function verifyZeroExReceipt(p: QuotePayload, receipt: Awaited<ReturnType<ChainReader["getTransactionReceipt"]>>): ToolOutcome {
  const transfers = parseEventLogs({ abi: ERC20_TRANSFER_EVENT, logs: receipt.logs as Log[] }).filter(
    (e) => e.address.toLowerCase() === p.sellToken.toLowerCase(),
  );
  const feeTransfers = transfers.filter((e) => e.args.to.toLowerCase() === p.feeRecipient.toLowerCase());
  const feePaid = feeTransfers.reduce((s, e) => s + e.args.value, 0n);
  const checks = [
    { name: "receipt.status", ok: receipt.status === "success", expected: "success", actual: receipt.status },
    { name: "tx.from == taker", ok: receipt.from.toLowerCase() === p.taker.toLowerCase(), expected: p.taker, actual: receipt.from },
    { name: "fee transfer (exact, sell token)", ok: feePaid.toString() === p.feeAmount, expected: p.feeAmount, actual: feePaid.toString() },
    { name: "single fee transfer", ok: feeTransfers.length === 1, expected: "1", actual: String(feeTransfers.length) },
  ];
  return {
    ok: true,
    data: { verified: checks.every((c) => c.ok), transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), checks },
  };
}

// ============================================================ delegated execution (Base Sepolia + Base mainnet)

import {
  DELEGATED_EXECUTOR_ABI,
  DELEGATED_SWAP_MODULE_ABI,
  DELEGATED_EXECUTOR_FEE_BPS,
  buildDelegatedSwapParams,
  delegatedChainLabel,
  delegatedExecutorAddressFor,
  isDelegatedChainId,
} from "@/lib/executor/delegated-executor";
import { delegatedBroadcasterAddressFor } from "@/lib/delegated/delegated-broadcaster";
import { validateDelegatedTransaction } from "@/lib/delegated/broadcast-gate";
import { isAutonomousProductionEnabled } from "@/lib/autonomy/config";
import { logEmergencySwitchDecision, readAutonomousEmergencySwitch, emergencySwitchBlocksExecution } from "@/lib/autonomy/emergency-switch";

/**
 * mpgr_delegate_swap — the delegated execution capability. The CALLER (the
 * autonomy runtime's execution adapter) has already validated policy,
 * authorization slots, quote freshness and idempotency. This function only
 * rebuilds deterministic parameters from the bound values, encodes the
 * executor call and broadcasts with the operator broadcaster. The user's
 * signature travels as authorization bytes; it is never logged.
 */
export async function delegateSwap(deps: McpDeps, input: unknown, onStage?: (stage: "estimate" | "send") => void): Promise<ToolOutcome> {
  const args = asRecord(input);
  const chainId = parseChainId(args.chainId);
  if (!isDelegatedChainId(chainId)) {
    return fail("UNSUPPORTED_CHAIN", "Delegated execution runs on Base (8453) or Base Sepolia (84532) only.");
  }
  // The chain's delegated executor must be PINNED. On Base Sepolia that is the
  // code-pinned Phase 2 deployment; on Base mainnet it is the operator-supplied
  // MPGR_MAINNET_DELEGATED_EXECUTOR. Absent => fail closed, never a guess.
  const executor = delegatedExecutorAddressFor(chainId);
  if (!executor) {
    return fail(
      "EXECUTOR_NOT_CONFIGURED",
      `No delegated executor is pinned for ${delegatedChainLabel(chainId)}, so delegated execution is unavailable there (fail-closed).`,
    );
  }
  // EXPLICIT PRODUCTION GATE (Base mainnet only). Defence in depth at the
  // broadcast chokepoint: even if a caller somehow bypassed the autonomy
  // runtime's adapter gate, a mainnet delegated broadcast additionally
  // requires AUTONOMOUS_PRODUCTION_ENABLED=true in the deployment env.
  // Missing/false/malformed fails closed BEFORE any parameter is parsed,
  // any calldata is built, or any key is touched. Base Sepolia is unaffected.
  // Ordered after the executor pin so the Phase-6 refusal taxonomy
  // (EXECUTOR_NOT_CONFIGURED on an unpinned mainnet) is preserved exactly —
  // both reasons are fail-closed; neither can ever produce a broadcast.
  if (chainId === BASE_MAINNET_CHAIN_ID && !isAutonomousProductionEnabled()) {
    return fail(
      "PRODUCTION_GATE_DISABLED",
      "Autonomous production execution on Base mainnet is gated by AUTONOMOUS_PRODUCTION_ENABLED (fail-closed). Nothing was signed or broadcast.",
    );
  }
  const emergency = await readAutonomousEmergencySwitch();
  if (emergencySwitchBlocksExecution(emergency)) {
    logEmergencySwitchDecision({ warn: () => {} }, emergency, { chainId, chokepoint: "mcp_delegateSwap" });
    return fail(
      "EXECUTION_UNAVAILABLE",
      `Autonomous execution refused by emergency switch (${emergency.reason}). Nothing was signed or broadcast.`,
    );
  }
  const broadcast = deps.delegatedBroadcaster;
  if (!broadcast) return fail("BROADCASTER_NOT_CONFIGURED", "Delegated execution is not configured on the server (fail-closed).");
  const auth = asRecord(args.authorization);
  const permit = asRecord(auth.permit);
  const permitted = asRecord(permit.permitted);
  const witness = asRecord(auth.witness);
  const sig = normalizeWalletSignature(auth.signature);
  if (!sig) return fail("INVALID_AUTHORIZATION", "Signature must be a wallet signature (65-byte or smart-wallet).");
  const numeric = (v: unknown) => (typeof v === "string" && /^\d{1,78}$/.test(v) ? BigInt(v) : null);
  const addr = (v: unknown) => (typeof v === "string" && isAddress(v) ? getAddress(v) : null);
  const tokenIn = addr(permitted.token);
  const amount = numeric(permitted.amount);
  const nonce = numeric(permit.nonce);
  const deadline = numeric(permit.deadline ?? args.deadline);
  const owner = addr(witness.owner);
  const buyToken = addr(witness.buyToken);
  const minOut = numeric(witness.minAmountOut);
  const policyHash = typeof witness.policyHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(witness.policyHash) ? witness.policyHash : null;
  const actionId = typeof witness.actionId === "string" && /^0x[0-9a-fA-F]{64}$/.test(witness.actionId) ? witness.actionId : null;
  const intentId = typeof args.intentId === "string" && /^0x[0-9a-fA-F]{64}$/.test(args.intentId) ? args.intentId : null;
  const router = addr(args.router);
  const poolFee = typeof args.poolFee === "number" && [100, 500, 3000, 10000].includes(args.poolFee) ? args.poolFee : null;
  const tickSpacing = typeof args.tickSpacing === "number" && Number.isInteger(args.tickSpacing) ? args.tickSpacing : null;
  if (!tokenIn || !buyToken || !owner || amount === null || nonce === null || deadline === null || minOut === null || !policyHash || !actionId || !intentId) {
    return fail("INVALID_AUTHORIZATION", "Delegated authorization is incomplete or malformed.");
  }
  const grossAmountIn = amount;
  const fee = (grossAmountIn * BigInt(DELEGATED_EXECUTOR_FEE_BPS)) / 10_000n;
  if (fee === 0n) return fail("FEE_ROUNDS_TO_ZERO", "Amount too small for the 0.25% trading fee.");
  const expectedFeeAmount = typeof args.expectedFeeAmount === "string" && /^\d{1,78}$/.test(args.expectedFeeAmount) ? BigInt(args.expectedFeeAmount) : null;
  if (expectedFeeAmount !== fee) return fail("FEE_MISMATCH", "Committed fee does not equal the 0.25% trading fee floor(gross * 25 / 10000) — refusing (fail-closed).");
  // VENUE (router + pool key) is derived from the chain's OWN delegated
  // registry when one is configured, so the caller cannot steer execution to
  // an arbitrary router. Base mainnet B20 pairs are Aerodrome Slipstream
  // (tickSpacing), USDC<->WETH is Uniswap V3 (poolFee) — the previous
  // UniswapV3-only encoding could never express a mainnet B20 trade.
  const delegatedRegistry = deps.delegatedRegistry?.[chainId];
  const route = delegatedRegistry ? findExecutorRoute(delegatedRegistry, tokenIn, buyToken) : null;
  if (delegatedRegistry && !route) {
    return fail("NO_ROUTE", `No delegated executor route for this pair on ${delegatedChainLabel(chainId)}.`);
  }
  if (route && router && route.router.toLowerCase() !== router.toLowerCase()) {
    return fail("ROUTE_MISMATCH", "router does not match the delegated executor route for this pair.");
  }
  const venueRouter = route ? route.router : router;
  if (!venueRouter) return fail("INVALID_AUTHORIZATION", "router is required when no delegated registry is configured.");
  type Venue = { kind: number; poolFee: number | null; tickSpacing: number | null };
  let venue: Venue | null = null;
  if (route) {
    if (route.kind === RouterKind.UNISWAP_V3_ROUTER02) {
      venue = { kind: RouterKind.UNISWAP_V3_ROUTER02, poolFee: route.poolFee ?? null, tickSpacing: null };
    } else if (route.kind === RouterKind.AERODROME_SLIPSTREAM) {
      venue = { kind: RouterKind.AERODROME_SLIPSTREAM, poolFee: null, tickSpacing: route.tickSpacing ?? null };
    } else if (route.kind === RouterKind.TYPED_SWAP_MODULE) {
      venue = { kind: RouterKind.TYPED_SWAP_MODULE, poolFee: null, tickSpacing: null };
    }
  } else if (poolFee !== null) {
    venue = { kind: RouterKind.UNISWAP_V3_ROUTER02, poolFee, tickSpacing: null };
  } else if (tickSpacing !== null) {
    venue = { kind: RouterKind.AERODROME_SLIPSTREAM, poolFee: null, tickSpacing };
  }
  if (!venue) return fail("INVALID_VENUE", "provide a registered Uniswap V3, Slipstream or typed-module route.");
  if (venue.kind === RouterKind.UNISWAP_V3_ROUTER02 && venue.poolFee === null) return fail("INVALID_VENUE", "Uniswap V3 route is missing its poolFee.");
  if (venue.kind === RouterKind.AERODROME_SLIPSTREAM && venue.tickSpacing === null) return fail("INVALID_VENUE", "Slipstream route is missing its tickSpacing.");

  if (venue.kind === RouterKind.TYPED_SWAP_MODULE) {
    if (!route || route.kind !== RouterKind.TYPED_SWAP_MODULE || !route.moduleAddress || !route.moduleCodeHash) {
      return fail("INVALID_VENUE", "Typed-module route requires a pinned module address and code hash.");
    }
    if (!(await typedModulePostureMatches(deps.reader(chainId), executor, route))) {
      return fail("ROUTE_MISMATCH", "Typed-module route does not match the executor's live module address and code hash.");
    }
  }

  const params = buildDelegatedSwapParams({
    router: venueRouter, tokenIn, tokenOut: buyToken, grossAmountIn: grossAmountIn.toString(),
    minAmountOut: minOut.toString(), deadline: Number(deadline), intentId: intentId as `0x${string}`, owner,
    feeBps: DELEGATED_EXECUTOR_FEE_BPS,
  });
  if (params.expectedFeeAmount !== fee) return fail("FEE_MISMATCH", "Fee math divergence — refusing (fail-closed).");
  const authorizationTuple = {
    permit: { permitted: { token: tokenIn, amount }, nonce, deadline },
    witness: { owner, buyToken, minAmountOut: minOut, deadline, actionId: actionId as Hex, policyHash: policyHash as Hex },
    signature: sig as Hex,
  };
  const data =
    venue.kind === RouterKind.AERODROME_SLIPSTREAM
      ? encodeFunctionData({
          abi: DELEGATED_EXECUTOR_ABI,
          functionName: "swapOnBehalfOfSlipstream",
          args: [params, venue.tickSpacing as number, authorizationTuple],
        })
      : venue.kind === RouterKind.TYPED_SWAP_MODULE
        ? encodeFunctionData({
            abi: DELEGATED_EXECUTOR_ABI,
            functionName: "swapOnBehalfOfTypedModule",
            args: [params, authorizationTuple],
          })
        : encodeFunctionData({
            abi: DELEGATED_EXECUTOR_ABI,
            functionName: "swapOnBehalfOfUniswapV3",
            args: [params, venue.poolFee as number, authorizationTuple],
          });
  try {
    // BOUNDED HOT WALLET (audit MC-2 remediation). Before the operator key
    // signs anything, re-decode this exact calldata and re-verify every signed
    // field against the user's own witness: chain, pinned executor, allowed
    // selector, recipient == owner, intentId, deadline, minAmountOut, buyToken,
    // permit token/amount/deadline, zero native value, positive amounts,
    // unexpired deadline. Any disagreement => no signature, no broadcast. The
    // on-chain `_validate` re-checks the same bindings, so this is defence in
    // depth that also keeps the operator key useless for anything else.
    const gate = validateDelegatedTransaction(
      { to: executor, data, chainId, value: 0n },
      {
        witness: {
          owner,
          buyToken,
          minAmountOut: minOut.toString(),
          deadline: Number(deadline),
          actionId: actionId as Hex,
          policyHash: policyHash as Hex,
        },
        permit: { token: tokenIn, amount: amount.toString(), nonce: nonce.toString(), deadline: Number(deadline) },
        wallet: owner,
      },
      new Date(),
    );
    if (!gate.allowed) {
      return fail("BROADCAST_REFUSED_BY_GATE", `refused to sign: ${gate.reason}${gate.detail ? ` (${gate.detail})` : ""}`);
    }

    const txHash = await broadcast({ to: executor, data, chainId, value: 0n }, onStage);
    return {
      ok: true,
      data: jsonSafe({
        txHash,
        delegatedExecutor: executor,
        chainId,
        expectedSender: delegatedBroadcasterAddressFor(chainId),
      }) as Record<string, unknown>,
    };
  } catch (error) {
    // PHASE 5: sanitized diagnostics — the fail-closed message carries the
    // underlying cause (viem shortMessage) so operators can diagnose a failed
    // broadcast WITHOUT weakening the safety semantics. URLs (possible RPC
    // endpoints) are stripped; the message is length-capped. No key material
    // can appear here (viem never places the signing key in error messages).
    // A viem TimeoutError means the bounded RPC gave up (DELEGATED_MAINNET_RPC_BOUNDS):
    // name it as such instead of echoing viem's generic sentence.
    const errorName = (error as { name?: unknown })?.name;
    const raw = errorName === "TimeoutError"
      ? "RPC request timed out"
      : typeof (error as { shortMessage?: unknown })?.shortMessage === "string"
        ? (error as { shortMessage: string }).shortMessage
        : error instanceof Error
          ? error.message
          : String(error);
    const sanitized = raw.replace(/https?:\/\/\S+/g, "[rpc]").slice(0, 240);
    // A node-reported revert (the gas estimate, or a submit rejected as reverting)
    // means the transaction was NOT accepted. It is a deterministic refusal, not an
    // infrastructure outage, so it is EXECUTION_UNAVAILABLE: a pre-broadcast refusal
    // that counts toward the goal's failure limit instead of retrying forever.
    if (errorName === "EstimateGasExecutionError" || /revert/i.test(raw)) {
      return fail(
        "EXECUTION_UNAVAILABLE",
        `Delegated broadcast refused by the node (${sanitized}). Nothing was broadcast, and the authorization slot was not consumed.`,
      );
    }
    // Any other failure with no hash: the slot is NOT consumed and stays usable. A
    // timed-out send's outcome is unknown; the on-chain Permit2 nonce is the guard
    // against a second execution of the same permit.
    return fail("RPC_ERROR", `Delegated broadcast failed (${sanitized}). No transaction hash was returned, so the authorization slot was not consumed.`);
  }
}
