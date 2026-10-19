import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, type Address, type PublicClient } from "viem";
import { RpcV2LiquiditySource } from "./rpc-source";
import { SWAP_PATH_VENUES } from "../swap-executor-config";
import { V4_MANAGER } from "./discovery";
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
describe("V2 canonical RPC pool discovery and venue ABIs (unit fixtures)",()=>{
  it("discovers non-catalog v3 fee tiers from factory events and quotes the five-field Router02 quoter ABI",async()=>{
    const r=reader(a=>a===SWAP_PATH_VENUES.uniswapV3.factory?[{args:{token0:A,token1:B,fee:2500,tickSpacing:50,pool:P}}]:[]);
    const source=new RpcV2LiquiditySource(client(r),500n);
    const pools=await source.pools(A,B);expect(pools).toHaveLength(1);expect(pools[0].poolFee).toBe(2500);
    expect(await source.quote(pools[0],A,9975n)).toBe(1000n);
    const abi=parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)"]);
    const args=decodeFunctionData({abi,data:r.call.mock.calls[0][0].data});
    expect(args.args[0]).toMatchObject({tokenIn:A,tokenOut:B,amountIn:9975n,fee:2500});
  });
  it("discovers Slipstream tick spacing from liquidity, not a fixed spacing list",async()=>{
    const r=reader(a=>a===SWAP_PATH_VENUES.slipstream.factory?[{args:{token0:A,token1:B,tickSpacing:17,pool:P}}]:[]);
    const source=new RpcV2LiquiditySource(client(r),500n);const [p]=await source.pools(A,B);expect(p.tickSpacing).toBe(17);
    await source.quote(p,A,9975n);
    const abi=parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)"]);
    expect(decodeFunctionData({abi,data:r.call.mock.calls[0][0].data}).args[0].tickSpacing).toBe(17);
  });
  it("uses v4 PoolKeys and native currency, never v3 getPool for v4",async()=>{
    const r=reader(a=>a===V4_MANAGER?[{args:{currency0:"0x0000000000000000000000000000000000000000",currency1:B,fee:0,tickSpacing:200,hooks:A,id:"0x1234"}}]:[]);
    const source=new RpcV2LiquiditySource(client(r),500n);const pools=await source.pools(weth,B);
    expect(pools[0].token0).toBe(weth);expect(pools[0].v4Key?.fee).toBe(0);
    r.call.mockResolvedValue({data:encodeAbiParameters([{type:"uint256"},{type:"uint256"}],[1000n,40000n])});
    expect(await source.quote(pools[0],weth,9975n)).toBe(1000n);
    const abi=parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256,uint256)"]);
    expect(decodeFunctionData({abi,data:r.call.mock.calls[0][0].data}).args[0]).toMatchObject({zeroForOne:true,exactAmount:9975n,poolKey:{fee:0,tickSpacing:200}});
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
