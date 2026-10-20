// lib/swap/v2/intent.ts
// Execution-intent inspection for MPGRSwapExecutorV2 transactions.
//
// Mirrors the V1 `inspectSwapExecutorTransaction` role: decode the exact
// calldata the wallet is about to sign and re-derive every economic and
// structural term independently, so a quote, a policy check, an approval and a
// receipt can never disagree about what is being executed.
//
// This is STRUCTURAL validation only. It proves the calldata is well-formed,
// fee-exact, recipient-exact and shaped the deployed contract will accept. It
// does NOT prove a pool exists or that the swap settles — that is the job of
// ./preflight.ts (live posture) and the pinned-block `eth_call` simulation.
// Every rule below is copied from contracts/swap/MPGRSwapExecutorV2.sol
// (swapExactInput, swapExactInputSplit, _validatePath, _validateHop, _begin,
// _validate) so the app can never build calldata the executor would revert on.
// Isomorphic on purpose: this module is pure (viem decoding + local constants,
// no I/O, no secrets) so the browser can re-validate the exact calldata a wallet
// is about to sign, mirroring V1's client-safe swap-executor-intent.ts. Anything
// that performs RPC stays server-only (execution.ts, preflight.ts, rpc-source.ts).
import { decodeFunctionData, type Address, type Hex } from "viem";
import { SWAP_V2_ABI } from "./abi";
import {
  SWAP_V2_ENABLED_KINDS, SWAP_V2_V4_POOL_MANAGER, SWAP_V2_WETH,
  swapV2Venue, type SwapV2ExecutorDeployment,
} from "./deployment";

export const SWAP_V2_FEE_DENOMINATOR = 10_000n;
/** floor(gross * feeBps / 10_000) — identical to the contract's Math.mulDiv. */
export const v2FeeFloor = (gross: bigint, feeBps = 25): bigint => (gross * BigInt(feeBps)) / SWAP_V2_FEE_DENOMINATOR;

export interface V2HopIntent {
  router: Address; tokenOut: Address; kind: number; poolFee: number; tickSpacing: number;
  stable: boolean; pool: Address; hookData: Hex;
  v4Key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } | null;
}
export interface V2SwapIntent {
  version: 2;
  entry: "swapExactInput" | "swapExactInputSplit";
  chainId: 8453;
  executor: Address;
  /** Approval spender: always the executor that receives this calldata. */
  spender: Address;
  router: Address;
  routerKind: number;
  taker: Address;
  recipient: Address;
  /** WETH-normalized: native ETH is sold/bought as canonical WETH on-chain. */
  tokenIn: Address;
  tokenOut: Address;
  grossAmountIn: bigint;
  expectedFeeAmount: bigint;
  swapAmountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  intentId: Hex;
  nativeIn: boolean;
  unwrapNativeOut: boolean;
  feeBps: number;
  feeRecipient: Address;
  authorizationKind: number;
  paths: readonly (readonly V2HopIntent[])[];
  /** Per-leg NET allocation; empty for the single-path entry point. */
  legAmounts: readonly bigint[];
  hops: number;
}
export type V2IntentResult = { ok: true; value: V2SwapIntent } | { ok: false; reason: string };

export interface V2IntentContext {
  deployment: SwapV2ExecutorDeployment;
  fromAddress: string;
  toAddress: string;
  taker: Address;
  nativeIn: boolean;
  nativeOut: boolean;
  /** Fee actually governed on-chain; read live by preflight, never assumed. */
  feeBps: number;
  feeRecipient: Address;
}
export interface V2TransactionLike { to: Address | string; data: Hex; value: bigint | string | number }

const fail = (reason: string): V2IntentResult => ({ ok: false, reason });
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isAddressLike = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const norm = (a: string) => (eq(a, "0x0000000000000000000000000000000000000000") ? SWAP_V2_WETH : a.toLowerCase());

interface RawHop {
  router: Address; tokenOut: Address; kind: number; poolFee: number; tickSpacing: number;
  stable: boolean; pool: Address; v4Key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }; hookData: Hex;
}

/** Validates one typed path exactly as the contract's `_validatePath` does. */
function validatePath(path: readonly RawHop[], tokenIn: Address, tokenOut: Address, deployment: SwapV2ExecutorDeployment): string | null {
  const n = path.length;
  if (n === 0 || n > 3) return "A V2 path must contain between one and three hops.";
  if (!eq(path[n - 1].tokenOut, tokenOut)) return "The final hop must deliver the requested receive token.";
  let input = tokenIn;
  for (let i = 0; i < n; i++) {
    const hop = path[i];
    if (eq(hop.tokenOut, tokenIn)) return "A hop cannot route back to the sell token.";
    if (i + 1 < n && eq(hop.tokenOut, tokenOut)) return "Only the final hop may deliver the receive token.";
    for (let j = 0; j < i; j++) if (eq(path[j].tokenOut, hop.tokenOut)) return "A path cannot revisit an intermediate token.";
    if (!SWAP_V2_ENABLED_KINDS.includes(hop.kind as (typeof SWAP_V2_ENABLED_KINDS)[number])) {
      return `Router kind ${hop.kind} is not an enabled V2 venue. Pancake and 0x remain disabled.`;
    }
    const venue = swapV2Venue(deployment, hop.kind);
    if (!venue) return `No registered V2 venue for kind ${hop.kind}.`;
    if (!eq(hop.router, venue.router)) return `Hop router is not the allowlisted ${venue.name} router.`;
    if (!isAddressLike(hop.pool) || BigInt(hop.pool) === 0n) return "A hop must name a concrete pool.";
    if (hop.kind === 7) {
      // V2 _validateHop: router, factory and pool must all be the canonical
      // PoolManager; the PoolKey carries the real pool identity.
      if (!eq(hop.pool, SWAP_V2_V4_POOL_MANAGER)) return "A v4 hop must name the canonical PoolManager as its pool.";
      const key = hop.v4Key;
      if (!key || !isAddressLike(key.currency0) || !isAddressLike(key.currency1)) return "A v4 hop requires a full PoolKey.";
      if (BigInt(key.currency0) >= BigInt(key.currency1)) return "A v4 PoolKey must order currency0 < currency1.";
      if (!Number.isInteger(key.tickSpacing) || key.tickSpacing <= 0 || key.tickSpacing > 32767) return "A v4 PoolKey tickSpacing is out of range.";
      if (!eq(norm(key.currency0), norm(input)) || !eq(norm(key.currency1), hop.tokenOut.toLowerCase())) {
        return "The v4 PoolKey currencies do not match this hop's sell and receive tokens.";
      }
    } else {
      if (eq(hop.pool, hop.router) || eq(hop.pool, venue.factory)) return "A pool cannot be the router or factory itself.";
      if (hop.kind === 2 && !(hop.poolFee > 0)) return "A Uniswap v3 hop requires a positive pool fee tier.";
      if (hop.kind === 1 && !(hop.tickSpacing > 0)) return "A Slipstream hop requires a positive tick spacing.";
      if (hop.kind === 1 && eq(hop.router, SWAP_V2_V4_POOL_MANAGER)) return "A Slipstream hop cannot use the PoolManager router.";
      if (hop.v4Key && (BigInt(hop.v4Key.currency0) !== 0n || BigInt(hop.v4Key.currency1) !== 0n)) {
        return "A non-v4 hop must leave the PoolKey zeroed.";
      }
    }
    input = hop.tokenOut;
  }
  return null;
}

const toHopIntent = (hop: RawHop): V2HopIntent => ({
  router: hop.router, tokenOut: hop.tokenOut, kind: Number(hop.kind),
  poolFee: Number(hop.poolFee ?? 0), tickSpacing: Number(hop.tickSpacing ?? 0),
  stable: hop.stable === true, pool: hop.pool, hookData: (hop.hookData ?? "0x") as Hex,
  v4Key: Number(hop.kind) === 7 && hop.v4Key
    ? { currency0: hop.v4Key.currency0, currency1: hop.v4Key.currency1, fee: Number(hop.v4Key.fee), tickSpacing: Number(hop.v4Key.tickSpacing), hooks: hop.v4Key.hooks }
    : null,
});

/** Decodes and independently re-validates a V2 swap transaction. */
export function inspectV2SwapTransaction(transaction: V2TransactionLike, context: V2IntentContext): V2IntentResult {
  try {
    const { deployment, taker, feeBps, feeRecipient } = context;
    if (!transaction || !isAddressLike(transaction.to as string)) return fail("Missing V2 transaction target.");
    if (!eq(String(transaction.to), deployment.executor)) return fail("The V2 transaction does not target the sealed V2 executor.");
    if (typeof transaction.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(transaction.data) || transaction.data.length < 10) {
      return fail("Missing V2 calldata.");
    }
    const decoded = decodeFunctionData({ abi: SWAP_V2_ABI, data: transaction.data as Hex });
    const split = decoded.functionName === "swapExactInputSplit";
    if (decoded.functionName !== "swapExactInput" && !split) return fail("Unsupported V2 entry point; only swapExactInput and swapExactInputSplit are executable.");

    const [params, rawPaths, maybeAmounts] = decoded.args as [
      { router: Address; tokenIn: Address; tokenOut: Address; grossAmountIn: bigint; expectedFeeAmount: bigint; amountOutMinimum: bigint; recipient: Address; deadline: bigint; intentId: Hex; unwrapNativeOut: boolean },
      readonly RawHop[] | readonly (readonly RawHop[])[],
      readonly bigint[] | { kind: number; deadline: bigint; nonce: bigint; v: number; r: Hex; s: Hex; signature: Hex },
    ];
    const auth = (split ? decoded.args[3] : decoded.args[2]) as { kind: number };

    const gross = BigInt(params.grossAmountIn);
    if (gross <= 0n) return fail("The gross sell amount must be positive.");
    const fee = v2FeeFloor(gross, feeBps);
    // The contract reverts FeeMismatch unless the committed fee is exactly the
    // floor at the CURRENT governed fee, and FeeRoundsToZero when it vanishes.
    if (BigInt(params.expectedFeeAmount) !== fee) return fail("The committed fee is not floor(gross*feeBps/10000) at the governed fee.");
    if (feeBps !== 0 && fee === 0n) return fail("The sell amount is too small to collect the mandatory fee in atomic units.");
    const net = gross - fee;

    const nativeIn = context.nativeIn;
    const tokenIn = params.tokenIn;
    const tokenOut = params.tokenOut;
    if (nativeIn && !eq(tokenIn, SWAP_V2_WETH)) return fail("Native ETH sells must normalize the sell token to canonical WETH.");
    if (!eq(tokenIn, nativeIn ? SWAP_V2_WETH : context.fromAddress)) return fail("The calldata sell token is not the requested sell token.");
    if (!eq(tokenOut, context.nativeOut ? SWAP_V2_WETH : context.toAddress)) return fail("The calldata receive token is not the requested receive token.");
    if (eq(tokenIn, tokenOut)) return fail("The sell and receive tokens must differ.");
    if (params.unwrapNativeOut !== context.nativeOut) return fail("The unwrap flag does not match the requested native output.");
    if (params.unwrapNativeOut && !eq(tokenOut, SWAP_V2_WETH)) return fail("Unwrapping native output requires WETH as the receive token.");

    const value = BigInt(transaction.value ?? 0n);
    if (value !== (nativeIn ? gross : 0n)) return fail("The transaction value must equal the gross sell amount for native sells, and zero otherwise.");
    if (nativeIn && Number(auth?.kind ?? -1) !== 0) return fail("A native ETH sell requires the APPROVAL authorization kind.");

    if (!isAddressLike(params.recipient) || !eq(params.recipient, taker)) return fail("The output recipient must be the connected taker wallet.");
    if (BigInt(params.amountOutMinimum) <= 0n) return fail("The minimum receive amount must be positive.");
    if (BigInt(params.deadline) <= 0n) return fail("The deadline must be set.");
    if (typeof params.intentId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(params.intentId)) return fail("The intent id must be a bytes32 value.");

    const paths: readonly (readonly RawHop[])[] = split
      ? (rawPaths as readonly (readonly RawHop[])[])
      : [rawPaths as readonly RawHop[]];
    if (split) {
      const amounts = maybeAmounts as readonly bigint[];
      if (paths.length < 2 || paths.length > 4) return fail("A split route needs between two and four legs.");
      if (!Array.isArray(amounts) || amounts.length !== paths.length) return fail("Split leg amounts must match the number of legs.");
      let allocated = 0n;
      for (const amount of amounts) {
        if (BigInt(amount) <= 0n) return fail("Every split leg must allocate a positive amount.");
        allocated += BigInt(amount);
      }
      // The contract reverts BatchMismatch unless the legs consume exactly the
      // NET amount: the fee is taken once, on gross, before allocation.
      if (allocated !== net) return fail("Split legs must allocate exactly the net amount after the single gross fee.");
    } else if (paths.length !== 1) {
      return fail("A single-path transaction must carry exactly one path.");
    }
    if (!isAddressLike(params.router) || !eq(params.router, paths[0][0]?.router ?? "")) {
      return fail("The transaction router must be the first hop's allowlisted router.");
    }
    for (const path of paths) {
      const invalid = validatePath(path, tokenIn, tokenOut, deployment);
      if (invalid) return fail(invalid);
    }

    const kind = Number(paths[0][0].kind);
    const value_: V2SwapIntent = {
      version: 2, entry: split ? "swapExactInputSplit" : "swapExactInput", chainId: 8453,
      executor: deployment.executor, spender: deployment.executor,
      router: params.router, routerKind: kind, taker, recipient: params.recipient,
      tokenIn, tokenOut, grossAmountIn: gross, expectedFeeAmount: fee, swapAmountIn: net,
      amountOutMinimum: BigInt(params.amountOutMinimum), deadline: BigInt(params.deadline), intentId: params.intentId,
      nativeIn, unwrapNativeOut: params.unwrapNativeOut === true, feeBps, feeRecipient,
      authorizationKind: Number(auth?.kind ?? 0),
      paths: paths.map((path) => path.map(toHopIntent)),
      legAmounts: split ? (maybeAmounts as readonly bigint[]).map((amount) => BigInt(amount)) : [],
      hops: split ? paths.reduce((sum, path) => sum + path.length, 0) : paths[0].length,
    };
    return { ok: true, value: value_ };
  } catch {
    return fail("Malformed V2 executable swap. Request a fresh quote.");
  }
}
