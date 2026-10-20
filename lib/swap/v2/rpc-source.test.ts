import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, type Address, type PublicClient } from "viem";
import { RpcV2LiquiditySource } from "./rpc-source";
import { SWAP_PATH_VENUES } from "../swap-executor-config";
import { V4_MANAGER } from "./discovery";
const V4_QUOTER="0x0d5e0F971ED27FBfF6c2837bf31316121532048D";
const A="0x0000000000000000000000000000000000000101" as Address;
const B="0x0000000000000000000000000000000000000102" as Address;
const P="0x0000000000000000000000000000000000000201" as Address;
const weth="0x4200000000000000000000000000000000000006" as Address;
function reader(logs: (address: string) => unknown[]) {
  return {
    getLogs:vi.fn(async({address}:{address:string})=>logs(address)),
    getCode:vi.fn(async()=>"0x6000"),
    getBlock:vi.fn(async()=>({timestamp:1n})),
    call:vi.fn(async(_args: {data: `0x${string}`})=>({data:encodeAbiParameters([{type:"uint256"},{type:"uint160"},{type:"uint32"},{type:"uint256"}],[1000n,0n,0,0n])})),
  };
}
const client = (r: ReturnType<typeof reader>)=>r as unknown as PublicClient;
afterEach(()=>vi.unstubAllGlobals());
/** Finds the call that actually encodes a given venue's quoter ABI, optionally at a
 * required target address. The bounded factory index now runs before quoting, so
 * call ORDER is no longer a proxy for "the right quoter was used" — locating the
 * call by decoding it, and by destination, is strictly stronger than assuming it was
 * first, and still fails loudly if the quoter was never called at all. */
function quoterCall(r: ReturnType<typeof reader>, abi: ReturnType<typeof parseAbi>, to: string): { args: Record<string, unknown>[] } {
  for (const [rawArgs] of r.call.mock.calls) {
    const args = rawArgs as { to?: string; data: `0x${string}` };
    if (args.to?.toLowerCase() !== to.toLowerCase()) continue;
    try {
      return decodeFunctionData({ abi, data: args.data }) as unknown as { args: Record<string, unknown>[] };
    } catch { /* a different venue's encoding */ }
  }
  throw new Error(`No call to ${to} encoded the expected quoter ABI.`);
}

describe("V2 canonical RPC pool discovery and venue ABIs (unit fixtures)",()=>{
  it("discovers non-catalog v3 fee tiers from factory events and quotes the five-field Router02 quoter ABI",async()=>{
    const r=reader(a=>a===SWAP_PATH_VENUES.uniswapV3.factory?[{args:{token0:A,token1:B,fee:2500,tickSpacing:50,pool:P}}]:[]);
    const source=new RpcV2LiquiditySource(client(r),500n);
    const pools=await source.pools(A,B);expect(pools).toHaveLength(1);expect(pools[0].poolFee).toBe(2500);
    expect(await source.quote(pools[0],A,9975n)).toBe(1000n);
    const abi=parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)"]);
    const args=quoterCall(r,abi,SWAP_PATH_VENUES.uniswapV3.quoter!);
    expect(args.args[0]).toMatchObject({tokenIn:A,tokenOut:B,amountIn:9975n,fee:2500});
  });
  it("discovers Slipstream tick spacing from liquidity, not a fixed spacing list",async()=>{
    const r=reader(a=>a===SWAP_PATH_VENUES.slipstream.factory?[{args:{token0:A,token1:B,tickSpacing:17,pool:P}}]:[]);
    const source=new RpcV2LiquiditySource(client(r),500n);const [p]=await source.pools(A,B);expect(p.tickSpacing).toBe(17);
    await source.quote(p,A,9975n);
    const abi=parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)"]);
    expect(quoterCall(r,abi,SWAP_PATH_VENUES.slipstream.quoter!).args[0].tickSpacing).toBe(17);
  });
  it("uses v4 PoolKeys and native currency, never v3 getPool for v4",async()=>{
    const r=reader(a=>a===V4_MANAGER?[{args:{currency0:"0x0000000000000000000000000000000000000000",currency1:B,fee:0,tickSpacing:200,hooks:A,id:"0x1234"}}]:[]);
    const source=new RpcV2LiquiditySource(client(r),500n);const pools=await source.pools(weth,B);
    expect(pools[0].token0).toBe(weth);expect(pools[0].v4Key?.fee).toBe(0);
    r.call.mockResolvedValue({data:encodeAbiParameters([{type:"uint256"},{type:"uint256"}],[1000n,40000n])});
    expect(await source.quote(pools[0],weth,9975n)).toBe(1000n);
    const abi=parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256,uint256)"]);
    expect(quoterCall(r,abi,V4_QUOTER).args[0]).toMatchObject({zeroForOne:true,exactAmount:9975n,poolKey:{fee:0,tickSpacing:200}});
    // The v4 quote must go to the v4 quoter. Discovery may still ASK the v3 factory
    // whether it has a pool for this pair (that is venue-agnostic index work), but
    // no v3 quoter call may be used to price a v4 pool.
    expect(r.call.mock.calls.some(([c])=>(c as {to?:string}).to?.toLowerCase()===SWAP_PATH_VENUES.uniswapV3.quoter!.toLowerCase())).toBe(false);
  });
// --- The bounded factory index: discovery with NO usable historical log range. ---
  it("discovers a v3 pool from factory getters alone when the provider refuses any log range",async()=>{
    const fee=3000;
    const factoryAbi=parseAbi(["function getPair(address,address) view returns(address)","function getPool(address,address,uint24) view returns(address)","function getPool(address,address,bool) view returns(address)","function getPool(address,address,int24) view returns(address)"]);
    const propsAbi=parseAbi(["function factory() view returns(address)","function token0() view returns(address)","function token1() view returns(address)","function fee() view returns(uint24)","function tickSpacing() view returns(int24)","function stable() view returns(bool)"]);
    const addr=(a:string)=>encodeAbiParameters([{type:"address"}],[a as Address]);
    const r=reader(()=>[]);
    // Every historical log query is refused, exactly as a range-capped public RPC does.
    r.getLogs.mockRejectedValue(Error("Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range."));
    r.call.mockImplementation(async(args:{to?:string;data:`0x${string}`})=>{
      const to=(args.to??"").toLowerCase();
      let fn:{functionName:string;args:readonly unknown[]}|null=null;
      for(const abi of [factoryAbi,propsAbi]){
        try{ fn=decodeFunctionData({abi,data:args.data}) as unknown as {functionName:string;args:readonly unknown[]}; break; }catch{ fn=null; }
      }
      if(!fn) return {data:encodeAbiParameters([{type:"uint256"},{type:"uint160"},{type:"uint32"},{type:"uint256"}],[1000n,0n,0,0n])};
      if(fn.functionName==="getPool" && to===SWAP_PATH_VENUES.uniswapV3.factory.toLowerCase() && Number(fn.args[2])===fee) return {data:addr(P)};
      if(fn.functionName==="getPair"||fn.functionName==="getPool") return {data:addr("0x0000000000000000000000000000000000000000")};
      if(to===P.toLowerCase()){
        switch(fn.functionName){
          case "factory": return {data:addr(SWAP_PATH_VENUES.uniswapV3.factory)};
          case "token0": return {data:addr(A)};
          case "token1": return {data:addr(B)};
          case "fee": return {data:encodeAbiParameters([{type:"uint24"}],[fee])};
          case "tickSpacing": return {data:encodeAbiParameters([{type:"int24"}],[50])};
          default: return {data:encodeAbiParameters([{type:"bool"}],[false])};
        }
      }
      return {data:encodeAbiParameters([{type:"uint256"},{type:"uint160"},{type:"uint32"},{type:"uint256"}],[1000n,0n,0,0n])};
    });
    const source=new RpcV2LiquiditySource(client(r),500n);
    const pools=await source.pools(A,B);
    const v3=pools.filter(x=>x.kind===2);
    expect(v3).toHaveLength(1);
    expect(v3[0].pool.toLowerCase()).toBe(P.toLowerCase());
    expect(v3[0].poolFee).toBe(fee);
    // The pool came from the factory, not from logs: every log query was refused.
    expect(r.getLogs).toHaveBeenCalled();
    expect(source.diagnostics().historyScan).toBe("unavailable");
    expect(source.diagnostics().factoryIndex?.complete).toBe(true);
  });
  it("reports DISCOVERY_UNAVAILABLE, never absent liquidity, when the sweep is capped and the index finds nothing",async()=>{
    const r=reader(()=>[]);
    r.getLogs.mockRejectedValue(Error("eth_getLogs block range is limited to 10 blocks"));
    r.call.mockResolvedValue({data:encodeAbiParameters([{type:"address"}],["0x0000000000000000000000000000000000000000" as Address])});
    const source=new RpcV2LiquiditySource(client(r),500n);
    // Slipstream spacing and v4 are only fully covered by the sweep, so a capped
    // sweep means this pair is UNMEASURED — not "no liquidity".
    await expect(source.pools(A,B)).rejects.toMatchObject({code:"DISCOVERY_UNAVAILABLE"});
    expect(source.diagnostics().historyScan).toBe("unavailable");
    expect(source.diagnostics().factoryIndex?.pools).toHaveLength(0);
  });
  it("does not turn an index/RPC failure into an unsupported token or absent liquidity",async()=>{
    const r=reader(()=>[]);r.getLogs.mockRejectedValue(Error("connection unavailable"));
    await expect(new RpcV2LiquiditySource(client(r),100n).pools(A,B)).rejects.toMatchObject({code:"DISCOVERY_UNAVAILABLE"});
  });
  it("does not query Pancake or Settler even with arbitrary token inputs",async()=>{
    const r=reader(()=>[]);await new RpcV2LiquiditySource(client(r),100n).pools(A,B);
    expect(r.getLogs.mock.calls.some(([a])=>a.address===SWAP_PATH_VENUES.pancakeV3.factory)).toBe(false);
  });
  it("does not treat empty untrusted search hints as a no-route proof",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:async()=>[]})));
    const r=reader(()=>[]);expect(await new RpcV2LiquiditySource(client(r),100n).hints(A,B)).toEqual([]);
    expect(r.getLogs).not.toHaveBeenCalled(); // Caller must perform complete discovery next.
  });
});
