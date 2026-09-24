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
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";

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
  reader: (chainId: ExecutorChainId) => ChainReader;
  nowSeconds: () => number;
  quoteSecret?: string;
  /** Base mainnet MCP trading (0x native fee). OFF unless MPGR_MCP_ENABLE_BASE_MAINNET=true. */
  mainnetEnabled: boolean;
  /** Validated MPGR fee wallet for the 0x path (null => mainnet quotes refused). */
  mainnetFeeRecipient: Address | null;
  zeroExFetch?: typeof fetch;
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
    return {
      chainId,
      name: EXECUTOR_CHAIN_NAMES[chainId],
      explorer: EXECUTOR_EXPLORERS[chainId],
      executor: d
        ? { status: "deployed", address: d.executor, owner: d.owner, feeRecipient: d.feeRecipient, deployTx: d.deployTx, deployBlock: d.deployBlock }
        : { status: chainId === BASE_MAINNET_CHAIN_ID ? "not_deployed_mainnet_disabled" : "not_deployed" },
      tradingProviders:
        chainId === BASE_SEPOLIA_CHAIN_ID
          ? d
            ? ["mpgr-executor"]
            : []
          : deps.mainnetEnabled && deps.mainnetFeeRecipient
            ? ["0x-native-fee"]
            : [],
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
      providers: {
        "mpgr-executor": "Custom audited-style executor: typed Aerodrome Slipstream + Uniswap V3 adapters, allowlisted routers/tokens, exact fee, atomic.",
        "0x-native-fee": "0x Swap API (AllowanceHolder) with swapFeeToken=sellToken; quote rejected unless fee is exact. Base mainnet only, disabled by default.",
        "aerodrome-slipstream": "Via mpgr-executor (Base mainnet deployment pending; proven on a Base mainnet fork in CI).",
        "cdp-trade-api": "Not offered over MCP: CDP Swap API has no integrator-fee parameter and returns taker-bound calldata; the app UI keeps its existing flow.",
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
      nativeEth: { symbol: "ETH", via: d.weth, note: "Use \"ETH\" as sellToken/buyToken for native ETH." },
      tokens: d.tokens.map(tokenView),
      pairs: d.routes.map((r) => ({
        tokenA: r.tokenA,
        tokenB: r.tokenB,
        venue: r.kind === RouterKind.UNISWAP_V3_ROUTER02 ? "uniswap-v3" : "aerodrome-slipstream",
        poolFee: r.poolFee ?? null,
        tickSpacing: r.tickSpacing ?? null,
      })),
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

  if (chainId === BASE_MAINNET_CHAIN_ID) return quoteZeroEx(deps, args, taker, slippage);

  const d = deps.registry[chainId];
  if (!d) return fail("EXECUTOR_NOT_DEPLOYED", "The MPGR Executor is not yet deployed on Base Sepolia.");
  const sell = resolveToken(d, args.sellToken);
  const buy = resolveToken(d, args.buyToken);
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
  let expected: bigint;
  try {
    expected =
      route.kind === RouterKind.UNISWAP_V3_ROUTER02
        ? await quoteUniswapV3(reader, route.quoter, sell.token.address, buy.token.address, fee.value.swapAmountIn, route.poolFee ?? 0)
        : await quoteSlipstream(reader, route.quoter, sell.token.address, buy.token.address, fee.value.swapAmountIn, route.tickSpacing ?? 0);
  } catch {
    return fail("QUOTE_FAILED", "The on-chain quoter could not price this trade (insufficient liquidity?).");
  }

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

  const built = intentFromPayload(d, payload, signed.quoteId, "APPROVAL");
  if (!built.ok) return built;
  const balance = sell.native ? await reader.getBalance({ address: taker }) : await readTokenBalance(reader, sell.token.address, taker);
  return {
    ok: true,
    data: {
      ...intentView(built.intent, signed.quoteId),
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

// ============================================================ prepare

export async function prepareTrade(deps: McpDeps, input: unknown): Promise<ToolOutcome> {
  const args = asRecord(input);
  const now = deps.nowSeconds();
  const v = verifyQuoteId(args.quoteId, now, deps.quoteSecret);
  if (!v.ok) return fail(v.error.code, v.error.message);
  const p = v.payload;
  const quoteId = args.quoteId as string;
  if (p.provider === "0x-native-fee") return prepareZeroEx(deps, p, quoteId);

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
    signer = await recoverTypedDataAddress({ ...(typedData as Parameters<typeof recoverTypedDataAddress>[0]), signature });
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

  const d = deps.registry[chainId];
  if (!d) return fail("EXECUTOR_NOT_DEPLOYED", "Executor not deployed on this chain.");
  const built = intentFromPayload(d, p, args.quoteId as string, "APPROVAL");
  if (!built.ok) return built;
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
  return { ok: true, data: { ...zeroExView(q.value, signed.quoteId), expiresAt: payload.exp, nextStep: "Call mpgr_prepare_trade with this quoteId." } };
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
