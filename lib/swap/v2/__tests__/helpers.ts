// lib/swap/v2/__tests__/helpers.ts
// Offline fixtures for the V2 execution surface. No RPC, no mocks of on-chain
// state beyond explicitly fabricated readers: every test here proves app-side
// logic, and the fork workflow remains the only source of fork proof.
import { encodeFunctionData, type Address, type Hex } from "viem";
import { SWAP_V2_ABI } from "../abi";
import { SWAP_V2_SEALED_MANIFEST, type SwapV2ExecutorDeployment } from "../deployment";
import { V2_FEE_RECIPIENT, type Pool, type V2Quote } from "../discovery";

export const WETH: Address = "0x4200000000000000000000000000000000000006";
export const USDC: Address = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** Arbitrary imported tokens: neither is WETH, USDC or ETH, and neither is in
 * any catalog. Universal support must not depend on a major-asset hop. */
export const TOKEN_A: Address = "0xa111111111111111111111111111111111111111";
export const TOKEN_B: Address = "0xb222222222222222222222222222222222222222";
export const TOKEN_C: Address = "0xc333333333333333333333333333333333333333";
export const TOKEN_D: Address = "0xd444444444444444444444444444444444444444";
export const TAKER: Address = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
export const UNI_V3_ROUTER: Address = "0x2626664c2603336e57b271c5c0b26f421741e481";
export const UNI_V3_FACTORY: Address = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
export const SLIP_ROUTER: Address = "0x698cb2b6dd822994581fea6ea4fc755d1363a92f";
export const V4_MANAGER: Address = "0x498581ff718922c3f8e6a244956af099b2652b2b";
export const POOL_AB: Address = "0xe555555555555555555555555555555555555555";
export const POOL_AB_2: Address = "0xe666666666666666666666666666666666666666";
export const POOL_AC: Address = "0xe777777777777777777777777777777777777777";
export const POOL_CB: Address = "0xe888888888888888888888888888888888888888";
export const POOL_CD: Address = "0xeccccccccccccccccccccccccccccccccccccccc";
export const POOL_DB: Address = "0xeddddddddddddddddddddddddddddddddddddddd";
export const INTENT_ID: Hex = `0x${"ab".repeat(32)}` as Hex;
export const ZERO_KEY = { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x0000000000000000000000000000000000000000", fee: 0, tickSpacing: 0, hooks: "0x0000000000000000000000000000000000000000" } as const;
/** Hooks contract of the MPGR v4 pool, in its canonical EIP-55 form. viem
 * rejects mixed-case strings that are not a valid checksum, so tests must import
 * this constant instead of retyping the literal. */
export const HOOKS: Address = "0x985C14BAa2a18316ffdA0aeFB3a632fAdfcA2AcC";
/** viem returns EIP-55 checksummed addresses when decoding, while these fixtures
 * are lowercase. Address assertions must therefore be case-insensitive. */
export const lc = (value: string): string => value.toLowerCase();

export const deployment: SwapV2ExecutorDeployment = SWAP_V2_SEALED_MANIFEST;

/** A Uniswap v3 direct pool for an arbitrary imported pair. */
export const v3Pool = (token0: Address, token1: Address, pool: Address, poolFee = 500): Pool => ({
  id: `v3:${pool}:${poolFee}`, pool, router: UNI_V3_ROUTER, factory: UNI_V3_FACTORY, kind: 2,
  token0, token1, poolFee, tickSpacing: 0, stable: false,
});
export const slipPool = (token0: Address, token1: Address, pool: Address, tickSpacing = 100): Pool => ({
  id: `slip:${pool}:${tickSpacing}`, pool, router: SLIP_ROUTER, factory: "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef", kind: 1,
  token0, token1, poolFee: 0, tickSpacing, stable: false,
});
/** A canonical v4 PoolKey pool. currency0 < currency1 and native is the zero
 * address, exactly as the PoolManager derives it. */
export const v4Pool = (currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): Pool => ({
  id: `v4:${currency0}:${currency1}:${fee}:${tickSpacing}`, pool: V4_MANAGER, router: V4_MANAGER, factory: V4_MANAGER, kind: 7,
  token0: currency0 === "0x0000000000000000000000000000000000000000" ? WETH : currency0, token1: currency1,
  poolFee: 0, tickSpacing: 0, stable: false, v4Key: { currency0, currency1, fee, tickSpacing, hooks },
});

/** A single-leg direct quote for an arbitrary pair with the 25 bps gross fee. */
export function directQuote(overrides: Partial<V2Quote> = {}): V2Quote {
  const gross = overrides.gross ?? 1_000_000n;
  const fee = (gross * 25n) / 10_000n;
  const net = gross - fee;
  const amountOut = overrides.amountOut ?? 1_000n;
  return {
    tokenIn: TOKEN_A, tokenOut: TOKEN_B, gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT,
    fee, net, amountOut,
    legs: [{ pools: [v3Pool(TOKEN_A, TOKEN_B, POOL_AB)], tokens: [TOKEN_A, TOKEN_B], amountIn: net, amountOut }],
    ...overrides,
  };
}

export const auth = (kind = 0) => ({ kind, deadline: 0n, nonce: 0n, v: 0, r: `0x${"00".repeat(32)}` as Hex, s: `0x${"00".repeat(32)}` as Hex, signature: "0x" as Hex });

export interface ParamsInput {
  router?: Address; tokenIn?: Address; tokenOut?: Address; grossAmountIn?: bigint;
  expectedFeeAmount?: bigint; amountOutMinimum?: bigint; recipient?: Address;
  deadline?: bigint; intentId?: Hex; unwrapNativeOut?: boolean;
}
export const params = (gross = 1_000_000n, overrides: ParamsInput = {}) => ({
  router: overrides.router ?? UNI_V3_ROUTER,
  tokenIn: overrides.tokenIn ?? TOKEN_A,
  tokenOut: overrides.tokenOut ?? TOKEN_B,
  grossAmountIn: overrides.grossAmountIn ?? gross,
  expectedFeeAmount: overrides.expectedFeeAmount ?? (gross * 25n) / 10_000n,
  amountOutMinimum: overrides.amountOutMinimum ?? 900n,
  recipient: overrides.recipient ?? TAKER,
  deadline: overrides.deadline ?? 9_999_999_999n,
  intentId: overrides.intentId ?? INTENT_ID,
  unwrapNativeOut: overrides.unwrapNativeOut ?? false,
});

export interface HopInput {
  router?: Address; tokenOut?: Address; kind?: number; poolFee?: number;
  tickSpacing?: number; stable?: boolean; pool?: Address; v4Key?: unknown; hookData?: Hex;
}
export const hop = (overrides: HopInput = {}) => ({
  router: overrides.router ?? UNI_V3_ROUTER,
  tokenOut: overrides.tokenOut ?? TOKEN_B,
  kind: overrides.kind ?? 2,
  poolFee: overrides.poolFee ?? (overrides.kind === undefined || overrides.kind === 2 ? 500 : 0),
  tickSpacing: overrides.tickSpacing ?? (overrides.kind === 1 ? 100 : 0),
  stable: overrides.stable ?? false,
  pool: overrides.pool ?? POOL_AB,
  v4Key: overrides.v4Key ?? ZERO_KEY,
  hookData: overrides.hookData ?? ("0x" as Hex),
});

export const encodeSingle = (p: unknown, path: readonly unknown[], a = auth()) =>
  encodeFunctionData({ abi: SWAP_V2_ABI, functionName: "swapExactInput", args: [p, path, a] as never }) as Hex;
export const encodeSplit = (p: unknown, paths: readonly (readonly unknown[])[], amounts: readonly bigint[], a = auth()) =>
  encodeFunctionData({ abi: SWAP_V2_ABI, functionName: "swapExactInputSplit", args: [p, paths, amounts, a] as never }) as Hex;

export interface IntentContextOverrides {
  fromAddress?: string; toAddress?: string; taker?: Address; nativeIn?: boolean;
  nativeOut?: boolean; feeBps?: number; feeRecipient?: Address;
  deployment?: SwapV2ExecutorDeployment;
}
export const intentContext = (o: IntentContextOverrides = {}) => ({
  deployment: o.deployment ?? deployment,
  fromAddress: o.fromAddress ?? TOKEN_A,
  toAddress: o.toAddress ?? TOKEN_B,
  taker: o.taker ?? TAKER,
  nativeIn: o.nativeIn ?? false,
  nativeOut: o.nativeOut ?? false,
  feeBps: o.feeBps ?? 25,
  feeRecipient: o.feeRecipient ?? V2_FEE_RECIPIENT,
});
