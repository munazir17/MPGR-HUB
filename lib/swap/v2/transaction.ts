import "server-only";
import { encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { SWAP_V2_ABI } from "./abi";
import { validateV2Quote, V2_FEE_RECIPIENT, type Pool, type V2Quote } from "./discovery";
const SAFE = "0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B";
const z32 = `0x${"00".repeat(32)}` as Hex;
export function buildV2Transaction(q: V2Quote, executor: Address, taker: Address, deadline: bigint, slippageBps: number, nativeIn = false, nativeOut = false, intentId: Hex = z32) {
  validateV2Quote(q);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw Error("Invalid slippage");
  const weth = "0x4200000000000000000000000000000000000006";
  if ((nativeIn && q.tokenIn.toLowerCase() !== weth) || (nativeOut && q.tokenOut.toLowerCase() !== weth)) throw Error("Native side must normalize to WETH");
  const minimum = q.amountOut * BigInt(10000 - slippageBps) / 10000n;
  if (minimum <= 0n) throw Error("Zero minimum output");
  const hop = (p: Pool, output: Address) => ({ router: p.router, tokenOut: output, kind: p.kind, poolFee: p.poolFee, tickSpacing: p.tickSpacing, stable: p.stable, pool: p.pool,
    v4Key: p.v4Key ?? { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress }, hookData: "0x" as Hex });
  const paths = q.legs.map(l => l.pools.map((p, i) => hop(p, l.tokens[i + 1])));
  const params = { router: paths[0][0].router, tokenIn: q.tokenIn, tokenOut: q.tokenOut, grossAmountIn: q.gross, expectedFeeAmount: q.fee, amountOutMinimum: minimum, recipient: taker, deadline, intentId, unwrapNativeOut: nativeOut };
  const auth = { kind: 0, deadline: 0n, nonce: 0n, v: 0, r: z32, s: z32, signature: "0x" as Hex };
  const data = paths.length === 1
    ? encodeFunctionData({ abi: SWAP_V2_ABI, functionName: "swapExactInput", args: [params, paths[0], auth] })
    : encodeFunctionData({ abi: SWAP_V2_ABI, functionName: "swapExactInputSplit", args: [params, paths, q.legs.map(l => l.amountIn), auth] });
  return { to: executor, data, value: nativeIn ? q.gross : 0n, minimum };
}
/** Explicit future activation boundary: caller cannot supply a deployment via
 * the API. Until a sealed V2 deployment is committed, quotes stay non-executable.
 * Wallet balance/allowance and the actual executor must eth_call successfully. */
export async function simulateV2Transaction(client: PublicClient, q: V2Quote, executor: Address, taker: Address, blockNumber: bigint, deadline: bigint, slippageBps: number, nativeIn = false, nativeOut = false) {
  if (await client.getChainId() !== 8453) throw Error("Not Base");
  const [fee, cap, recipient, owner, code] = await Promise.all([
    client.readContract({ address: executor, abi: SWAP_V2_ABI, functionName: "feeBps", blockNumber }),
    client.readContract({ address: executor, abi: SWAP_V2_ABI, functionName: "MAX_FEE_BPS", blockNumber }),
    client.readContract({ address: executor, abi: SWAP_V2_ABI, functionName: "feeRecipient", blockNumber }),
    client.readContract({ address: executor, abi: SWAP_V2_ABI, functionName: "owner", blockNumber }),
    client.getCode({ address: executor, blockNumber }),
  ]);
  if (fee !== 25 || cap !== 100 || recipient.toLowerCase() !== V2_FEE_RECIPIENT.toLowerCase() || owner.toLowerCase() !== SAFE.toLowerCase() || !code || code === "0x") throw Error("V2 deployment pin mismatch");
  const tx = buildV2Transaction(q, executor, taker, deadline, slippageBps, nativeIn, nativeOut);
  const result = await client.call({ account: taker, to: executor, data: tx.data, value: tx.value, blockNumber });
  if (!result.data || BigInt(result.data) < tx.minimum) throw Error("Executor simulation failed minimum output");
  return { ...tx, simulated: true as const, blockNumber };
}
