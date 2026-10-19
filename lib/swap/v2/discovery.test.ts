import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData, type Address } from "viem";
import { discoverV2Quote, validateV2Quote, V2_FEE_RECIPIENT, V2_DEPLOYMENT, type Pool, type LiquiditySource } from "./discovery";
import { buildV2Transaction } from "./transaction";
import { SWAP_V2_ABI } from "./abi";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [A, B, X, Y, Z] = [101, 102, 103, 104, 105].map(addr);
const edge = (id: number, a: Address, b: Address, kind: Pool["kind"] = 3): Pool => ({ id: String(id), token0: a, token1: b, pool: addr(id+1000), router: addr(id+2000), factory: addr(id+3000), kind, poolFee: 0, tickSpacing: 0, stable: false });
function source(edges: Pool[], price: (p: Pool, amount: bigint) => bigint = (_, a) => a): LiquiditySource {
  return { pools: vi.fn(async (input, output) => edges.filter(p => [p.token0,p.token1].includes(input) && (!output || [p.token0,p.token1].includes(output)))), quote: vi.fn(async (p, _, a) => price(p, a)) };
}
describe("unreleased permissionless V2 discovery (unit policy, not fork proof)", () => {
  it("has no activated deployment", () => expect(V2_DEPLOYMENT).toBeNull());
  it("quotes an imported arbitrary direct token/token pair without catalog or major asset", async () => {
    const s = source([edge(1,A,B)]); const q = await discoverV2Quote(s,A,B,10001n);
    expect(q.fee).toBe(25n);expect(q.net).toBe(9976n);expect(q.amountOut).toBe(9976n);expect(q.legs[0].tokens).toEqual([A,B]);
    expect(q.feeRecipient).toBe(V2_FEE_RECIPIENT);
  });
  it("never rewrites a quotable direct pair into a more profitable bridge", async () => {
    const s = source([edge(1,A,B),edge(2,A,X),edge(3,X,B)], (p,a) => p.id === "1" ? a : a*10n);
    const q=await discoverV2Quote(s,A,B,10000n);expect(q.legs[0].tokens).toEqual([A,B]);expect(s.pools).toHaveBeenCalledTimes(1);
  });
  it("discovers an arbitrary non-major intermediate only when direct quotes fail", async () => {
    const s = source([edge(1,A,B),edge(2,A,X),edge(3,X,B)], (p,a) => p.id === "1" ? 0n : a);
    const q=await discoverV2Quote(s,A,B,10000n);expect(q.legs[0].tokens).toEqual([A,X,B]);expect(q.fee).toBe(25n);
  });
  it("finds three hops through two liquidity-discovered long-tail intermediates", async () => {
    const q=await discoverV2Quote(source([edge(1,A,X),edge(2,X,Y),edge(3,Y,B)]),A,B,10000n);
    expect(q.legs[0].tokens).toEqual([A,X,Y,B]);
  });
  it("rejects routes over three hops and returns LIQUIDITY_UNAVAILABLE", async () => {
    await expect(discoverV2Quote(source([edge(1,A,X),edge(2,X,Y),edge(3,Y,Z),edge(4,Z,B)]),A,B,10000n)).rejects.toMatchObject({code:"LIQUIDITY_UNAVAILABLE"});
  });
  it("returns LIQUIDITY_UNAVAILABLE for an unknown valid pair with no pool", async () => {
    await expect(discoverV2Quote(source([]),A,B,10000n)).rejects.toMatchObject({code:"LIQUIDITY_UNAVAILABLE"});
  });
  it("chooses the simpler route on net-output ties", async () => {
    const q=await discoverV2Quote(source([edge(1,A,X),edge(2,X,B),edge(3,A,Y),edge(4,Y,Z),edge(5,Z,B)]),A,B,10000n);
    expect(q.legs[0].pools).toHaveLength(2);
  });
  it("splits across distinct pools only when better and fees gross once", async () => {
    const s=source([edge(1,A,B),edge(2,A,B)], (_,a) => a > 6000n ? a/2n : a);
    const q=await discoverV2Quote(s,A,B,10001n);expect(q.legs).toHaveLength(2);expect(q.fee).toBe(25n);
    expect(q.legs.reduce((s,l)=>s+l.amountIn,0n)).toBe(9976n);expect(q.amountOut).toBe(9976n);
    const tx=buildV2Transaction(q,addr(500),addr(501),123456n,100);
    const decoded=decodeFunctionData({abi:SWAP_V2_ABI,data:tx.data});expect(decoded.functionName).toBe("swapExactInputSplit");
    if(decoded.functionName === "swapExactInputSplit") {expect(decoded.args[0].expectedFeeAmount).toBe(25n);expect(decoded.args[2].reduce((s,a)=>s+a,0n)).toBe(9976n);}
  });
  it("rejects zero/forged fees and recipients before calldata is built", async () => {
    const q=await discoverV2Quote(source([edge(1,A,B)]),A,B,10000n);
    for(const bad of [{...q,fee:0n},{...q,feeBps:0},{...q,feeRecipient:A},{...q,net:q.gross}]) {
      expect(()=>validateV2Quote(bad as typeof q)).toThrow();expect(()=>buildV2Transaction(bad as typeof q,addr(1),addr(2),123n,100)).toThrow();
    }
  });
  it("accepts dynamically indexed v3 tiers, Slipstream spacings and v4 PoolKeys", async () => {
    for(const kind of [1,2,4,7] as const) {
      const p={...edge(kind,A,B,kind),poolFee:kind===2?2500:0,tickSpacing:kind===1?17:0};
      const q=await discoverV2Quote(source([p]),A,B,10000n);expect(q.legs[0].pools[0].kind).toBe(kind);
    }
  });
  it("does not enable Pancake or Settler even if an index returns them", async () => {
    await expect(discoverV2Quote(source([{...edge(1,A,B),kind:5} as unknown as Pool]),A,B,10000n)).rejects.toMatchObject({code:"LIQUIDITY_UNAVAILABLE"});
  });
  it("rejects invalid addresses, equal tokens, ETH/WETH and fee-rounds-to-zero", async () => {
    await expect(discoverV2Quote(source([]),"bad",B,10000n)).rejects.toMatchObject({code:"INVALID_PAIR"});
    await expect(discoverV2Quote(source([]),A,A,10000n)).rejects.toMatchObject({code:"INVALID_PAIR"});
    await expect(discoverV2Quote(source([]),"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE","0x4200000000000000000000000000000000000006",10000n)).rejects.toMatchObject({code:"INVALID_PAIR"});
    await expect(discoverV2Quote(source([]),A,B,399n)).rejects.toMatchObject({code:"INVALID_AMOUNT"});
  });
});
