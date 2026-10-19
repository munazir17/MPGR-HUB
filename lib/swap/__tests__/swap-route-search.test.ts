import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractFunctionRevertedError, type Address } from "viem";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as d, BASE_MAINNET_UNISWAP_V3 as uni, BASE_MAINNET_SLIPSTREAM as slip } from "@/lib/executor/executor-config";
import { MANUAL_SWAP_TOKENS } from "@/lib/trade/manual-swap";
import { NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import { resetTradeQuoteCache } from "@/lib/trade/trade-quote-cache";
import { inspectExecutorSwapTransaction } from "@/lib/executor/executor-intent";
import { simulatedSwapReceipt } from "@/tests/mobile/swap-receipt-fixture";
import { searchSwapRoutes } from "../swap-route-search";
import { swapRouteCandidates, swapRouteKey } from "../swap-route-candidates";
import { swapQuotePolicyError, verifySwapSettlement } from "../swap-policy";
import { type SwapRouteReadClient } from "../swap-route-selection";
const wallet = "0x2222222222222222222222222222222222222222";
const hash = `0x${"ab".repeat(32)}` as const;
const pool = (i:number) => `0x${(0x90000+i).toString(16).padStart(40,"0")}` as Address;
let from:string, to:string, blockTime:bigint, denied:boolean, feeBps:number, recipient:string, owner:string, chain:number, reorg:boolean;
let allowance:bigint, executorFailed:Set<string>, executorUnavailable:Set<string>, executorMismatch:boolean;
let failed:Set<string>, absent:Set<string>, outputs:Map<string,bigint>, advance:number;
const read=vi.fn(), simulate=vi.fn(), code=vi.fn();
const client = { getChainId:async()=>chain, getBlockNumber:async()=>100n,
  getBlock:async()=>({number:100n,hash:reorg && simulate.mock.calls.length ? `0x${"cd".repeat(32)}` : hash,timestamp:blockTime}),
  readContract:read,simulateContract:simulate,getCode:code,getBalance:async()=>10n**30n } as unknown as SwapRouteReadClient;
const token = (address:string) => MANUAL_SWAP_TOKENS.find(t=>t.address.toLowerCase()===address.toLowerCase())!;
const input = () => ({ from:token(from),to:token(to),fromAmount:(10n**BigInt(token(from).decimals)).toString(),taker:wallet,slippageBps:100 });
beforeEach(()=>{
  resetTradeQuoteCache();vi.resetAllMocks(); from=d.routes[0].tokenA;to=d.routes[0].tokenB;
  blockTime=BigInt(Math.floor(Date.now()/1000));denied=false;feeBps=25;recipient=d.feeRecipient;owner=d.owner;chain=8453;reorg=false;advance=0;
  allowance=0n;executorFailed=new Set();executorUnavailable=new Set();executorMismatch=false;failed=new Set();absent=new Set();outputs=new Map();code.mockResolvedValue("0x6000");
  read.mockImplementation(async({address,functionName,args})=>{
    const routes=swapRouteCandidates(from,to);
    if(functionName==="isTokenAllowed")return !denied;
    if(functionName==="routerKind")return args[0].toLowerCase()===uni.swapRouter02.toLowerCase()?2:1;
    if(address.toLowerCase()===d.executor.toLowerCase())return ({owner,paused:false,feeBps,feeRecipient:recipient,MAX_FEE_BPS:100})[functionName as "owner"];
    if(functionName==="decimals")return d.tokens.find(t=>t.address.toLowerCase()===address.toLowerCase())?.decimals;
    if(functionName==="allowance")return allowance;
    if(functionName==="balanceOf")return 10n**30n;
    if(functionName==="getPool"){
      const i=routes.findIndex(r=>r.kind===(address.toLowerCase()===uni.factory.toLowerCase()?2:1)&&(r.poolFee??r.tickSpacing)===args[2]);
      return absent.has(swapRouteKey(routes[i]))?`0x${"0".repeat(40)}`:pool(i);
    }
    const i=Number(BigInt(address))-0x90000,r=routes[i];
    if(r)return ({factory:r.kind===2?uni.factory:slip.factory,token0:r.tokenA,token1:r.tokenB,fee:r.poolFee,tickSpacing:r.tickSpacing})[functionName as "factory"];
    throw Error("Unexpected offline read");
  });
  simulate.mockImplementation(async({address,args,functionName})=>{
    if(address.toLowerCase()===d.executor.toLowerCase()){
      const r=swapRouteCandidates(from,to).find(r=>r.kind===(functionName==="swapUniswapV3ExactInputSingle"?2:1)&&(r.poolFee??r.tickSpacing)===args[1])!;
      const key=swapRouteKey(r);
      if(executorFailed.has(key))throw new ContractFunctionRevertedError({abi:[],functionName,message:"Simulated revert"});
      if(executorUnavailable.has(key))throw Error("private RPC simulation diagnostics");
      return {result:executorMismatch?1n:outputs.get(key)??(r.poolFee===500?1200n:1000n)};
    }
    const r=swapRouteCandidates(from,to).find(r=>r.quoter.toLowerCase()===address.toLowerCase()&&(r.poolFee??r.tickSpacing)===(args[0].fee??args[0].tickSpacing))!;
    if(failed.has(swapRouteKey(r)))throw Error("private RPC endpoint diagnostics");
    if(advance)vi.setSystemTime(Date.now()+advance);
    return {result:[outputs.get(swapRouteKey(r))??(r.poolFee===500?1200n:1000n),0n,0n,10000n]};
  });
});
describe("real proposal/encoding/policy pipeline with mocked RPC — not live execution evidence",()=>{
  it.each([[d.routes[0].tokenA,d.routes[0].tokenB],[d.routes[0].tokenB,d.routes[0].tokenA],[d.routes[1].tokenB,d.weth],[d.weth,d.routes[1].tokenB],[NATIVE_ETH_SENTINEL,d.routes[1].tokenB],[d.routes[1].tokenB,NATIVE_ETH_SENTINEL]])("%s → %s compares direct pools, exact post-fee input, approvals and receipt",async(a,b)=>{
    from=a;to=b;const p=(await searchSwapRoutes(client,input())).proposal;
    expect(p.swapRouting!.route.poolFee).toBe(500);expect(p.swapRouting!.outcomes).toHaveLength(5);expect(p.toAmount).toBe("1200");
    expect(p.swapRouting).toMatchObject({comparisonComplete:true,hops:1,quoterGasUnits:"10000",executionSimulation:a===NATIVE_ETH_SENTINEL?"eth-call-succeeded-no-settlement-proof":"not-run-wallet-preflight-required"});
    const x=inspectExecutorSwapTransaction(p.transaction!);expect(x.ok).toBe(true);if(!x.ok)throw Error(x.reason);
    const gross=BigInt(p.fromAmount);expect(x.value.expectedFeeAmount).toBe(gross*25n/10000n);
    expect(simulate.mock.calls.filter(([arg])=>arg.functionName==="quoteExactInputSingle").every(([arg])=>arg.blockNumber===100n&&arg.args[0].amountIn===gross-gross*25n/10000n)).toBe(true);
    expect(p.transaction!.value).toBe(a===NATIVE_ETH_SENTINEL?p.fromAmount:"0");expect(p.needsPermit2Approval).toBe(a!==NATIVE_ETH_SENTINEL);
    expect(swapQuotePolicyError(p)).toBeNull();expect(verifySwapSettlement(p,simulatedSwapReceipt(p,hash)).verified).toBe(true);
    expect(verifySwapSettlement(p,simulatedSwapReceipt(p,hash,{feeRecipient:wallet})).verified).toBe(false);
    expect(read.mock.calls.every(([arg])=>arg.blockNumber===100n)).toBe(true);
  });
  it("falls back only to another qualified fee-compatible candidate, and reports partial search",async()=>{
    const best=swapRouteCandidates(from,to).find(r=>r.poolFee===500)!;failed.add(swapRouteKey(best));
    const p=(await searchSwapRoutes(client,input())).proposal;expect(p.toAmount).toBe("1000");expect(p.swapRouting!.comparisonComplete).toBe(false);
    expect(p.swapRouting!.outcomes.find(o=>o.key===swapRouteKey(best))).toMatchObject({state:"unavailable",output:null});
    expect(JSON.stringify(p)).not.toContain("private RPC");expect(swapQuotePolicyError(p)).toBeNull();
  });
  it("missing configured/default pool does not prevent a compatible alternative",async()=>{
    absent.add(swapRouteKey(swapRouteCandidates(from,to)[0]));const p=(await searchSwapRoutes(client,input())).proposal;expect(p.toAmount).toBe("1200");
  });
  it("positive-output ties keep deterministic original venue priority",async()=>{
    for(const r of swapRouteCandidates(from,to))outputs.set(swapRouteKey(r),1000n);
    expect((await searchSwapRoutes(client,input())).proposal.swapRouting!.route.router).toBe(swapRouteCandidates(from,to)[0].router);
  });
  it("a denied venue can fall back to the other approved venue, never an external router",async()=>{
    const original=read.getMockImplementation()!;read.mockImplementation(a=>a.functionName==="routerKind"?Promise.resolve(a.args[0].toLowerCase()===uni.swapRouter02.toLowerCase()?0:1):original(a));
    expect((await searchSwapRoutes(client,input())).proposal.swapRouting!.route.kind).toBe(1);
  });
  it.each(["recipient","fee","owner","token","network"])("%s drift or denial cannot escape through an alternative",async what=>{
    if(what==="recipient")recipient=wallet;if(what==="fee")feeBps=26;if(what==="owner")owner=wallet;if(what==="token")denied=true;if(what==="network")chain=1;
    await expect(searchSwapRoutes(client,input())).rejects.toMatchObject({status:what==="network"?503:422});expect(simulate).not.toHaveBeenCalled();
  });
  it("all unavailable quotes are a provider block, not proof of no liquidity",async()=>{
    failed=new Set(swapRouteCandidates(from,to).map(swapRouteKey));await expect(searchSwapRoutes(client,input())).rejects.toMatchObject({status:503});
  });
  it("zero-output pools cannot become an executable quote or a multi-hop fee-less fallback",async()=>{
    for(const r of swapRouteCandidates(from,to))outputs.set(swapRouteKey(r),0n);
    // No legacy winner: the fixed-fee path search is attempted but cannot
    // produce a quote from this offline mock, so the direct-route diagnosis
    // surfaces — never a quote, never a fee-less fallback.
    await expect(searchSwapRoutes(client,input())).rejects.toMatchObject({status:422,message:expect.stringContaining("reviewed MPGR executors")});
  });
  it("never memoizes permissions across cache hits",async()=>{
    await searchSwapRoutes(client,input());denied=true;await expect(searchSwapRoutes(client,input())).rejects.toMatchObject({reason:"EXECUTOR_PERMISSION_MISMATCH"});expect(simulate).toHaveBeenCalledTimes(5);
  });
  it("refresh requotes all candidates while an ordinary cache hit does not",async()=>{
    await searchSwapRoutes(client,input());await searchSwapRoutes(client,input());expect(simulate).toHaveBeenCalledTimes(5);
    await searchSwapRoutes(client,input(),true);expect(simulate).toHaveBeenCalledTimes(10);
  });
  it("reorg during comparison invalidates previously positive candidates",async()=>{
    reorg=true;await expect(searchSwapRoutes(client,input())).rejects.toMatchObject({reason:"BLOCK_CHANGED"});
  });
  it("slow quotes cannot extend snapshot or proposal lifetime",async()=>{
    vi.useFakeTimers();try{advance=31000;await expect(searchSwapRoutes(client,input())).rejects.toMatchObject({reason:"STALE_BLOCK"});}finally{vi.useRealTimers();}
  });
  it("unknown metadata/import is discovery-only: path search attempts live executor verification and fails closed offline",async()=>{
    // Permissionless tokens may enter the fixed-fee path SEARCH once the
    // reviewed deployment is active, but imported metadata alone never makes
    // a route executable: the search must first verify the deployed
    // executor's live posture on-chain. This offline mock cannot answer that
    // read, so the search fails closed and nothing is prepared or simulated.
    const x={...input(),to:{...input().to,address:wallet as Address}};await expect(searchSwapRoutes(client,x)).rejects.toMatchObject({reason:"ROUTE_VERIFICATION_UNAVAILABLE",status:503});expect(simulate).not.toHaveBeenCalled();
  });
  it.each(["0","-1","1.2","1e9","399",String(2n**256n)])("rejects invalid gross atomic input %s before RPC",async fromAmount=>{
    await expect(searchSwapRoutes(client,{...input(),fromAmount})).rejects.toMatchObject({reason:"INVALID_INPUT"});expect(read).not.toHaveBeenCalled();
  });
});

it("reorg after a rejected first pool cannot reuse permission reads from the previous hash",async()=>{
  absent.add(swapRouteKey(swapRouteCandidates(from,to)[0]));
  const changedClient={...client,getBlock:async()=>({number:100n,timestamp:blockTime,hash:read.mock.calls.some(([a])=>a.functionName==="getPool")?`0x${"cd".repeat(32)}` as const:hash})};
  await expect(searchSwapRoutes(changedClient,input())).rejects.toMatchObject({reason:"BLOCK_CHANGED"});expect(simulate).not.toHaveBeenCalled();
});
it("the scheduling budget stops additional candidates and discloses a partial comparison",async()=>{
  vi.useFakeTimers();try{
    advance=13000;const p=(await searchSwapRoutes(client,input())).proposal;
    expect(simulate).toHaveBeenCalledTimes(1);expect(p.swapRouting!.comparisonComplete).toBe(false);
    expect(p.swapRouting!.outcomes.filter(o=>o.reason==="SEARCH_BUDGET_EXCEEDED")).toHaveLength(4);
  }finally{vi.useRealTimers();}
});

it("funded and approved taker gets actual Executor eth_call per candidate, without overrides or broadcasts",async()=>{
 allowance=10n**30n;const p=(await searchSwapRoutes(client,input())).proposal;
 expect(p.swapRouting!.executionSimulation).toBe("eth-call-succeeded-no-settlement-proof");
 const calls=simulate.mock.calls.filter(([arg])=>arg.address.toLowerCase()===d.executor.toLowerCase());expect(calls).toHaveLength(5);
 expect(calls.every(([arg])=>arg.account===wallet&&arg.blockNumber===100n&&arg.value===0n&&!('stateOverride' in arg))).toBe(true);
});
it("a higher quoter result that reverts on Executor is excluded in favor of a working candidate",async()=>{
 allowance=10n**30n;executorFailed.add(swapRouteKey(swapRouteCandidates(from,to).find(r=>r.poolFee===500)!));
 const p=(await searchSwapRoutes(client,input())).proposal;expect(p.toAmount).toBe("1000");
 expect(p.swapRouting!.executionSimulation).toBe("eth-call-succeeded-no-settlement-proof");
 expect(p.swapRouting!.outcomes.find(o=>o.reason==="EXECUTOR_SIMULATION_REVERTED")).toMatchObject({state:"rejected",output:null});
});
it("unknown Executor simulation is excluded and disclosed as partial, not called illiquid",async()=>{
 allowance=10n**30n;executorUnavailable.add(swapRouteKey(swapRouteCandidates(from,to).find(r=>r.poolFee===500)!));
 const p=(await searchSwapRoutes(client,input())).proposal;expect(p.toAmount).toBe("1000");expect(p.swapRouting!.comparisonComplete).toBe(false);
 expect(JSON.stringify(p)).not.toContain("private RPC");
});
it("a simulated output differing from the reviewed quote/minimum cannot be selected",async()=>{
 allowance=10n**30n;executorMismatch=true;await expect(searchSwapRoutes(client,input())).rejects.toMatchObject({reason:"EXECUTOR_QUOTE_MISMATCH",status:422});
});
