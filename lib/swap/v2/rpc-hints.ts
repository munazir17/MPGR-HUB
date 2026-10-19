// Untrusted search hints accelerate direct discovery on range-limited RPCs.
// A hint NEVER authorizes execution: canonical factory equality (or the actual
// v4 Initialize event and PoolKey hash) is required before it becomes a Pool.
import "server-only";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, encodeAbiParameters, parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import { SWAP_PATH_VENUES } from "../swap-executor-config";
import { V4_MANAGER, type Pool } from "./discovery";
type Reader = Pick<PublicClient, "call" | "getLogs"> & { getBlock(args: {blockNumber: bigint}): Promise<{timestamp: bigint}> };
const props = parseAbi(["function factory() view returns(address)","function token0() view returns(address)","function token1() view returns(address)","function fee() view returns(uint24)","function tickSpacing() view returns(int24)","function stable() view returns(bool)"]);
const factories = parseAbi(["function getPair(address,address) view returns(address)","function getPool(address,address,uint24) view returns(address)","function getPool(address,address,int24) view returns(address)","function getPool(address,address,bool) view returns(address)"]);
const slipFactory = parseAbi(["function getPool(address,address,int24) view returns(address)"]);
const init = parseAbiItem("event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)");
const weth = "0x4200000000000000000000000000000000000006";
const norm = (a: string) => a.toLowerCase() === "0x0000000000000000000000000000000000000000" ? weth : a.toLowerCase();
interface Hint { pairAddress: string; pairCreatedAt?: number }
export async function directRpcHints(client: Reader, input: Address, output: Address, blockNumber: bigint): Promise<Pool[]> {
  const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${input}`, {signal:AbortSignal.timeout(8000)});
  if (!response.ok) return [];
  const rows: unknown = await response.json(); if (!Array.isArray(rows)) return [];
  const pools = new Map<string, Pool>();
  async function property<T>(address: Address, name: "factory"|"token0"|"token1"|"fee"|"tickSpacing"|"stable"): Promise<T> {
    const r=await client.call({to:address,data:encodeFunctionData({abi:props,functionName:name}),blockNumber});
    if(!r.data) throw Error("No pool metadata");
    return decodeFunctionResult({abi:props,functionName:name,data:r.data}) as T;
  }
  for (const row of rows as Hint[]) {
    if (!row || typeof row.pairAddress !== "string") continue;
    try {
      if (/^0x[\da-f]{40}$/i.test(row.pairAddress)) {
        const address=row.pairAddress as Address;
        const [factory,token0,token1]=await Promise.all([property<Address>(address,"factory"),property<Address>(address,"token0"),property<Address>(address,"token1")]);
        if (!((norm(token0)===norm(input)&&norm(token1)===norm(output)) || (norm(token1)===norm(input)&&norm(token0)===norm(output)))) continue;
        const v=Object.values(SWAP_PATH_VENUES).find(v=>v.kind!==5 && v.factory.toLowerCase()===factory.toLowerCase());
        if (!v || v.kind===5) continue;
        const fee=v.kind===2 ? await property<number>(address,"fee") : 0;
        const spacing=v.kind===1 ? await property<number>(address,"tickSpacing") : 0;
        const stable=v.kind===4 ? await property<boolean>(address,"stable") : false;
        const data=v.kind===3 ? encodeFunctionData({abi:factories,functionName:"getPair",args:[input,output]})
          :v.kind===2 ? encodeFunctionData({abi:factories,functionName:"getPool",args:[input,output,fee]})
          :v.kind===1 ? encodeFunctionData({abi:slipFactory,functionName:"getPool",args:[input,output,spacing]})
          :encodeFunctionData({abi:factories,functionName:"getPool",args:[input,output,stable]});
        const canonical=await client.call({to:factory,data,blockNumber});
        if (!canonical.data || norm("0x"+canonical.data.slice(-40))!==norm(address)) continue;
        pools.set(address.toLowerCase(),{id:address.toLowerCase(),pool:address,router:v.router,factory,kind:v.kind,token0,token1,poolFee:fee,tickSpacing:spacing,stable});
      } else if (/^0x[\da-f]{64}$/i.test(row.pairAddress) && Number.isFinite(row.pairCreatedAt)) {
        let lo=0n,hi=blockNumber;const timestamp=BigInt(Math.floor(row.pairCreatedAt!/1000));
        while(lo<hi) {const mid=(lo+hi)/2n;if((await client.getBlock({blockNumber:mid})).timestamp<timestamp) lo=mid+1n;else hi=mid;}
        const from=lo>4n?lo-4n:0n;
        const logs=await client.getLogs({address:V4_MANAGER,event:init,args:{id:row.pairAddress as `0x${string}`},fromBlock:from,toBlock:from+9n>blockNumber?blockNumber:from+9n,strict:true});
        for(const log of logs) {
          const {args:k}=decodeEventLog({abi:[init],data:log.data,topics:log.topics});
          if(!((norm(k.currency0)===norm(input)&&norm(k.currency1)===norm(output))||(norm(k.currency1)===norm(input)&&norm(k.currency0)===norm(output)))) continue;
          const key={currency0:k.currency0,currency1:k.currency1,fee:k.fee,tickSpacing:k.tickSpacing,hooks:k.hooks};
          if(keccak256(encodeAbiParameters([{type:"address"},{type:"address"},{type:"uint24"},{type:"int24"},{type:"address"}],[key.currency0,key.currency1,key.fee,key.tickSpacing,key.hooks]))!==k.id) continue;
          pools.set(k.id,{id:k.id,pool:V4_MANAGER,router:V4_MANAGER,factory:V4_MANAGER,kind:7,token0:norm(key.currency0) as Address,token1:norm(key.currency1) as Address,poolFee:0,tickSpacing:0,stable:false,v4Key:key});
        }
      }
    } catch { /* A hint isn't proof. Missing/counterfeit/reverting hints are discarded. */ }
  }
  return [...pools.values()];
}
