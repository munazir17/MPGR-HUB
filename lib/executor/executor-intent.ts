// lib/executor/executor-intent.ts
//
// Pure builders for MPGR Executor trades. NOTHING here signs or sends:
//   intent  ->  (optional) EIP-2612 / Permit2 typed data for the USER'S wallet
//           ->  unsigned transaction request { to: executor, data, value }
//
// The executor re-validates every field on-chain; these checks exist so an
// agent can never even be handed a transaction that would redirect output,
// skip/duplicate the fee, or target a non-allowlisted router/token.

import {
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseSignature,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

import {
  AuthKind,
  RouterKind,
  UNISWAP_V3_POOL_FEES,
  findExecutorRoute,
  findExecutorToken,
  type AuthorizationMode,
  type ExecutorDeployment,
  type ExecutorRoute,
  type ExecutorToken,
} from "./executor-config";
import { computeExecutorFee } from "./executor-fee";
import { MPGR_EXECUTOR_ABI } from "./mpgr-executor-abi";

export const EXECUTOR_MAX_SLIPPAGE_BPS = 500; // mirrors TRADE_MAX_SLIPPAGE_BPS
export const EXECUTOR_MIN_SLIPPAGE_BPS = 1;
export const EXECUTOR_MAX_DEADLINE_SECONDS = 30 * 60;

export interface ExecutorSwapIntent {
  version: 1;
  chainId: number;
  executor: Address;
  router: Address;
  routerKind: ExecutorRoute["kind"];
  poolFee?: number;
  tickSpacing?: number;
  taker: Address;
  /** Always equal to `taker` (enforced here AND on-chain). */
  recipient: Address;
  sellToken: ExecutorToken;
  buyToken: ExecutorToken;
  /** Pay with native ETH (sellToken must be WETH; value == sellAmount). */
  sellNative: boolean;
  /** Receive native ETH (buyToken must be WETH; executor unwraps). */
  buyNative: boolean;
  /** Gross sell amount in base units (decimal string). */
  sellAmount: string;
  feeBps: number;
  feeAmount: string;
  /** Fee asset == sell asset. "ETH" when paying natively. */
  feeToken: Address | "ETH";
  feeRecipient: Address;
  swapAmount: string;
  expectedBuyAmount: string;
  minBuyAmount: string;
  slippageBps: number;
  /** Unix seconds. */
  deadline: number;
  intentId: Hex;
  authorization: AuthorizationMode;
  /** Address the user must approve: executor (APPROVAL/EIP2612) or Permit2 (PERMIT2). */
  spender: Address;
}

export type IntentError = { code: string; message: string };
export type IntentResult<T> = { ok: true; value: T } | { ok: false; error: IntentError };

const fail = (code: string, message: string): { ok: false; error: IntentError } => ({
  ok: false,
  error: { code, message },
});

export function intentIdFromQuoteId(quoteId: string): Hex {
  return keccak256(stringToHex(`mpgr-executor-intent:${quoteId}`));
}

export interface BuildIntentInput {
  deployment: ExecutorDeployment;
  taker: string;
  sellToken: string;
  buyToken: string;
  sellNative?: boolean;
  buyNative?: boolean;
  sellAmount: bigint;
  /** Quoter output for `swapAmount` (i.e. AFTER the fee is taken). */
  expectedBuyAmount: bigint;
  slippageBps: number;
  authorization: AuthorizationMode;
  nowSeconds: number;
  deadlineSeconds?: number;
  quoteId: string;
  /** Live on-chain fee values (must be read from the executor, not assumed). */
  feeBps: number;
  feeRecipient: string;
}

export function buildExecutorIntent(input: BuildIntentInput): IntentResult<ExecutorSwapIntent> {
  const d = input.deployment;
  if (!isAddress(input.taker)) return fail("INVALID_TAKER", "taker must be a valid address.");
  const taker = getAddress(input.taker);
  if (!isAddress(input.feeRecipient)) return fail("INVALID_FEE_RECIPIENT", "Executor fee recipient is invalid.");
  const feeRecipient = getAddress(input.feeRecipient);
  if (taker === feeRecipient) return fail("TAKER_IS_FEE_RECIPIENT", "The fee recipient cannot trade through the executor.");

  const sell = findExecutorToken(d, input.sellToken);
  const buy = findExecutorToken(d, input.buyToken);
  if (!sell) return fail("TOKEN_NOT_ALLOWED", `Sell token ${input.sellToken} is not allowlisted on this executor.`);
  if (!buy) return fail("TOKEN_NOT_ALLOWED", `Buy token ${input.buyToken} is not allowlisted on this executor.`);
  if (sell.address.toLowerCase() === buy.address.toLowerCase()) return fail("SAME_TOKEN", "Sell and buy token are the same.");

  const sellNative = input.sellNative === true;
  const buyNative = input.buyNative === true;
  if (sellNative && !sell.isWeth) return fail("NATIVE_REQUIRES_WETH", "Native ETH input requires the WETH route.");
  if (buyNative && !buy.isWeth) return fail("NATIVE_REQUIRES_WETH", "Native ETH output requires the WETH route.");
  if (sellNative && input.authorization !== "APPROVAL") {
    return fail("NATIVE_REQUIRES_APPROVAL_MODE", "Native ETH input needs no token approval; use authorization APPROVAL.");
  }

  const route = findExecutorRoute(d, sell.address, buy.address);
  if (!route) return fail("NO_ROUTE", "No allowlisted executor route for this pair.");
  if (route.kind === RouterKind.UNISWAP_V3_ROUTER02 && !UNISWAP_V3_POOL_FEES.includes(route.poolFee as never)) {
    return fail("INVALID_ROUTE", "Route has an invalid Uniswap V3 fee tier.");
  }
  if (route.kind === RouterKind.AERODROME_SLIPSTREAM && !(Number.isInteger(route.tickSpacing) && (route.tickSpacing ?? 0) > 0)) {
    return fail("INVALID_ROUTE", "Route has an invalid Slipstream tickSpacing.");
  }

  if (!Number.isInteger(input.slippageBps) || input.slippageBps < EXECUTOR_MIN_SLIPPAGE_BPS || input.slippageBps > EXECUTOR_MAX_SLIPPAGE_BPS) {
    return fail("INVALID_SLIPPAGE", `slippageBps must be between ${EXECUTOR_MIN_SLIPPAGE_BPS} and ${EXECUTOR_MAX_SLIPPAGE_BPS}.`);
  }

  const fee = computeExecutorFee(input.sellAmount, input.feeBps);
  if (!fee.ok) return fail(fee.error.code, fee.error.message);

  if (input.expectedBuyAmount <= 0n) return fail("NO_LIQUIDITY", "The quote returned zero output.");
  const minBuy = (input.expectedBuyAmount * BigInt(10_000 - input.slippageBps)) / 10_000n;
  if (minBuy <= 0n) return fail("ZERO_MIN_OUTPUT", "Minimum output rounds to zero; increase the amount.");

  const ttl = input.deadlineSeconds ?? 10 * 60;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > EXECUTOR_MAX_DEADLINE_SECONDS) {
    return fail("INVALID_DEADLINE", `Deadline must be within ${EXECUTOR_MAX_DEADLINE_SECONDS / 60} minutes.`);
  }

  return {
    ok: true,
    value: {
      version: 1,
      chainId: d.chainId,
      executor: getAddress(d.executor),
      router: getAddress(route.router),
      routerKind: route.kind,
      poolFee: route.kind === RouterKind.UNISWAP_V3_ROUTER02 ? route.poolFee : undefined,
      tickSpacing: route.kind === RouterKind.AERODROME_SLIPSTREAM ? route.tickSpacing : undefined,
      taker,
      recipient: taker,
      sellToken: sell,
      buyToken: buy,
      sellNative,
      buyNative,
      sellAmount: fee.value.grossAmountIn.toString(),
      feeBps: fee.value.feeBps,
      feeAmount: fee.value.feeAmount.toString(),
      feeToken: sellNative ? "ETH" : getAddress(sell.address),
      feeRecipient,
      swapAmount: fee.value.swapAmountIn.toString(),
      expectedBuyAmount: input.expectedBuyAmount.toString(),
      minBuyAmount: minBuy.toString(),
      slippageBps: input.slippageBps,
      deadline: input.nowSeconds + ttl,
      intentId: intentIdFromQuoteId(input.quoteId),
      authorization: input.authorization,
      spender: input.authorization === "PERMIT2" ? getAddress(d.permit2) : getAddress(d.executor),
    },
  };
}

/** The exact `SwapParams` tuple the executor receives. */
export function toSwapParams(intent: ExecutorSwapIntent) {
  return {
    router: intent.router,
    tokenIn: intent.sellToken.address,
    tokenOut: intent.buyToken.address,
    grossAmountIn: BigInt(intent.sellAmount),
    expectedFeeAmount: BigInt(intent.feeAmount),
    amountOutMinimum: BigInt(intent.minBuyAmount),
    recipient: intent.recipient,
    deadline: BigInt(intent.deadline),
    intentId: intent.intentId,
    unwrapNativeOut: intent.buyNative,
  } as const;
}

export interface ExecutorAuthorization {
  kind: number;
  deadline: bigint;
  nonce: bigint;
  v: number;
  r: Hex;
  s: Hex;
  signature: Hex;
}

const ZERO32 = `0x${"0".repeat(64)}` as Hex;

export function approvalAuthorization(): ExecutorAuthorization {
  return { kind: AuthKind.APPROVAL, deadline: 0n, nonce: 0n, v: 0, r: ZERO32, s: ZERO32, signature: "0x" };
}

/** EIP-2612 permit typed data for the user's wallet (value == gross, spender == executor). */
export function buildEip2612TypedData(
  intent: ExecutorSwapIntent,
  domain: { name: string; version: string; verifyingContract: Address },
  nonce: bigint,
  permitDeadline: number,
) {
  return {
    domain: { name: domain.name, version: domain.version, chainId: intent.chainId, verifyingContract: domain.verifyingContract },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    message: {
      owner: intent.taker,
      spender: intent.executor,
      value: BigInt(intent.sellAmount),
      nonce,
      deadline: BigInt(permitDeadline),
    },
  };
}

/** Permit2 SignatureTransfer typed data (amount == gross, spender == executor). */
export function buildPermit2TypedData(intent: ExecutorSwapIntent, permit2: Address, nonce: bigint, permitDeadline: number) {
  return {
    domain: { name: "Permit2", chainId: intent.chainId, verifyingContract: permit2 },
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom" as const,
    message: {
      permitted: { token: intent.sellToken.address, amount: BigInt(intent.sellAmount) },
      spender: intent.executor,
      nonce,
      deadline: BigInt(permitDeadline),
    },
  };
}

export function authorizationFromSignature(
  mode: Exclude<AuthorizationMode, "APPROVAL">,
  signature: Hex,
  nonce: bigint,
  permitDeadline: number,
): IntentResult<ExecutorAuthorization> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return fail("INVALID_SIGNATURE", "Signature must be a 65-byte hex string.");
  if (mode === "EIP2612") {
    const sig = parseSignature(signature);
    const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
    return {
      ok: true,
      value: { kind: AuthKind.EIP2612, deadline: BigInt(permitDeadline), nonce, v, r: sig.r, s: sig.s, signature: "0x" },
    };
  }
  return {
    ok: true,
    value: { kind: AuthKind.PERMIT2, deadline: BigInt(permitDeadline), nonce, v: 0, r: ZERO32, s: ZERO32, signature },
  };
}

export interface UnsignedTransactionRequest {
  chainId: number;
  to: Address;
  data: Hex;
  /** Wei, decimal string. Non-zero only for native-ETH sells (== sellAmount). */
  value: string;
}

export function encodeExecutorSwap(intent: ExecutorSwapIntent, auth: ExecutorAuthorization): UnsignedTransactionRequest {
  const params = toSwapParams(intent);
  const data =
    intent.routerKind === RouterKind.UNISWAP_V3_ROUTER02
      ? encodeFunctionData({
          abi: MPGR_EXECUTOR_ABI,
          functionName: "swapUniswapV3ExactInputSingle",
          args: [params, intent.poolFee as number, auth],
        })
      : encodeFunctionData({
          abi: MPGR_EXECUTOR_ABI,
          functionName: "swapSlipstreamExactInputSingle",
          args: [params, intent.tickSpacing as number, auth],
        });
  return {
    chainId: intent.chainId,
    to: intent.executor,
    data,
    value: intent.sellNative ? intent.sellAmount : "0",
  };
}

/** ERC-20 approve(spender, amount) — exact amount, never unlimited, for the APPROVAL/PERMIT2 setup step. */
export function encodeExactApproval(
  chainId: number,
  token: Address,
  spender: Address,
  amount: bigint,
): UnsignedTransactionRequest {
  return {
    chainId,
    to: token,
    data: encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ] as const,
      functionName: "approve",
      args: [spender, amount],
    }),
    value: "0",
  };
}
