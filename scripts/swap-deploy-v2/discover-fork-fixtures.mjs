// Read-only RPC discovery on the GitHub runner. Never reads a deployer key.
// Dexscreener supplies search hints only: the Initialize event and pool ID are
// independently verified on chain by the Foundry suite before use.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const rpcUrl = process.env.BASE_MAINNET_RPC_URL;
function fatal(error) {
  const message = String(error?.message ?? error).replaceAll(rpcUrl ?? 'UNSET_RPC', '[RPC]').replace(/[\r\n]/g, ' ');
  console.error('::error::V2 real-pool discovery failed: '+message);
  process.exit(1);
}
process.on('uncaughtException',fatal);
process.on('unhandledRejection',fatal);
const manager = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const mpgr = '0xb2000000000000000000008d204203177a78af01';
const cast = (...args) => execFileSync('cast', args, {encoding:'utf8'}).trim();
const topic = cast('keccak', 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
async function rpc(method, params) {
  for (let i=0;i<6;i++) {
    try {
      const r = await fetch(rpcUrl, {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
      const j = await r.json(); if (j.error) throw Error(j.error.message); return j.result;
    } catch (e) { if (i===5) throw e; await new Promise(r=>setTimeout(r,2000*(i+1))); }
  }
}
const chain = await rpc('eth_chainId',[]); if (Number(chain)!==8453) throw Error('Not Base');
if ((await rpc('eth_getCode',[manager,'latest']))==='0x') throw Error('PoolManager has no code');
const latest = Number(await rpc('eth_blockNumber',[]));
const hints = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${mpgr}`).then(r=>r.json());
if (!Array.isArray(hints)) throw Error('Pool discovery hints unavailable');
const candidates = hints.filter(p=>p.dexId==='uniswap' && /^0x[\da-f]{64}$/i.test(p.pairAddress));
console.log('MPGR v4 hint count:', candidates.length);
const wordAddress = a=>'0x'+a.slice(2).padStart(64,'0');
let found;
for (const p of candidates) {
  const timestamp = Math.floor(Number(p.pairCreatedAt)/1000);
  let low=0, high=latest;
  // Timestamp narrows the indexed Initialize search without scanning years of logs.
  if (!timestamp) continue;
  while (low<high) {
    const mid=Math.floor((low+high)/2);
    const b=await rpc('eth_getBlockByNumber',['0x'+mid.toString(16),false]);
    if (Number(b.timestamp)<timestamp) low=mid+1; else high=mid;
  }
  // Some configured RPC plans cap logs at ten blocks; honor that cap.
  let logs=[];
  for (const offset of [0,-10,10,-20,20,-30,30,-40,40,-50,50,-60,60,-70,70,-80,80,-90,90,-100,100]) {
    const from=Math.max(0,low-4+offset), to=Math.min(latest,from+9);
    logs=await rpc('eth_getLogs',[{address:manager,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:[topic,p.pairAddress]}]);
    if (logs.length) break;
  }
  for (const l of logs) {
    const c0='0x'+l.topics[2].slice(-40), c1='0x'+l.topics[3].slice(-40);
    if (![c0,c1].includes(mpgr)) continue;
    const other=c0===mpgr?c1:c0;
    if (!['0x0000000000000000000000000000000000000000','0x4200000000000000000000000000000000000006'].includes(other)) continue;
    const data=l.data.slice(2).match(/.{64}/g);
    found={currency0:c0,currency1:c1,fee:Number(BigInt('0x'+data[0])),tickSpacing:Number(BigInt('0x'+data[1])),hooks:'0x'+data[2].slice(-40),poolId:l.topics[1],initializeBlock:Number(l.blockNumber),initializeTx:l.transactionHash}; break;
  }
  if (found) break;
}
if (!found) throw Error('MPGR/ETH or MPGR/WETH real v4 Initialize event not found; no proof claimed');
mkdirSync('deployments/.local',{recursive:true});
writeFileSync('deployments/.local/v2-fork-fixtures.json',JSON.stringify({block:latest,manager,mpgr:found},null,2));
console.log('Verified on-chain MPGR Initialize event:', JSON.stringify(found));
