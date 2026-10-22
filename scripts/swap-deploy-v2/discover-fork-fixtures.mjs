// Read-only RPC discovery on the GitHub runner. Never reads a deployer key.
//
// Two independent ways to locate the real MPGR Uniswap V4 `Initialize` event:
//   1. Dexscreener supplies a pool-id search HINT (the original path).
//   2. A hint-free on-chain search by the event's indexed currencies, floored at
//      the token's own chain-derived deployment block (the fallback added after
//      the hint API returned no v4 pair and silently disabled the fork proof).
//
// Neither path hardcodes a pool result. In both, the pool id and PoolKey are read
// out of the matched on-chain log, and the Foundry suite then verifies them
// independently before use. If neither path finds the event, this exits non-zero
// and claims NO proof — a missing hint is never turned into a fabricated fixture.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  V4_POOL_MANAGER, decodeInitializeLog, findInitializeByCurrency, findInitializeByPoolId,
  findTokenDeploymentBlock,
} from './fork-fixture-discovery.mjs';

const rpcUrl = process.env.BASE_MAINNET_RPC_URL;
function fatal(error) {
  const message = String(error?.message ?? error).replaceAll(rpcUrl ?? 'UNSET_RPC', '[RPC]').replace(/[\r\n]/g, ' ');
  console.error('::error::V2 real-pool discovery failed: '+message);
  process.exit(1);
}
process.on('uncaughtException',fatal);
process.on('unhandledRejection',fatal);

const manager = V4_POOL_MANAGER;
const mpgr = '0xb2000000000000000000008d204203177a78af01';
const cast = (...args) => execFileSync('cast', args, {encoding:'utf8'}).trim();
const topic = cast('keccak', 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const log = (line) => console.log(`[discovery] ${line}`);

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
console.log('MPGR code prefix:', (await rpc('eth_getCode',[mpgr,'latest'])).slice(0,64));

/** Picks the MPGR/native-or-WETH Initialize log out of a set, or null. */
function selectFixture(logs, source) {
  for (const l of logs ?? []) {
    const fixture = decodeInitializeLog(l, { token: mpgr });
    if (fixture) { log(`${source}: verified Initialize at block ${fixture.initializeBlock}`); return fixture; }
  }
  return null;
}

// ---- Path 1: third-party search hint (pool id + creation timestamp). ----
let found;
let hints = [];
try {
  const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${mpgr}`);
  hints = await response.json();
  if (!Array.isArray(hints)) throw Error('Pool discovery hints unavailable');
} catch (error) {
  // A hint source being down must not abort discovery: path 2 needs no hints.
  log(`hint source unavailable (${String(error?.message ?? error).slice(0,140)}); continuing to the on-chain fallback`);
  hints = [];
}
const candidates = hints.filter(p=>p.dexId==='uniswap' && /^0x[\da-f]{64}$/i.test(p.pairAddress));
console.log('MPGR v4 hint count:', candidates.length);
for (const p of candidates) {
  const logs = await findInitializeByPoolId(rpc, {
    manager, topic, poolId: p.pairAddress, timestamp: Math.floor(Number(p.pairCreatedAt)/1000), latest, log,
  });
  found = selectFixture(logs, 'pool-id hint');
  if (found) break;
}

// ---- Path 2: hint-free on-chain search by indexed currency. ----
if (!found) {
  log('no fixture from hints; searching on chain by indexed currency');
  const fromBlock = await findTokenDeploymentBlock(rpc, { token: mpgr, latest });
  if (fromBlock === null) throw Error('MPGR token deployment block could not be located; no proof claimed');
  log(`MPGR runtime code first present at block ${fromBlock}; scanning forward to ${latest}`);
  const logs = await findInitializeByCurrency(rpc, { manager, topic, token: mpgr, fromBlock, latest, log });
  found = selectFixture(logs, 'on-chain currency search');
}

if (!found) throw Error('MPGR/ETH or MPGR/WETH real v4 Initialize event not found by hint or on-chain search; no proof claimed');
mkdirSync('deployments/.local',{recursive:true});
writeFileSync('deployments/.local/v2-fork-fixtures.json',JSON.stringify({block:latest,manager,mpgr:found},null,2));
console.log('Verified on-chain MPGR Initialize event:', JSON.stringify(found));
