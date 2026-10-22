// scripts/swap-deploy-v2/fork-fixture-discovery.mjs
// Read-only on-chain discovery of the real MPGR Uniswap V4 `Initialize` event.
//
// WHY THIS EXISTS. The fork proof used to depend entirely on a third-party search
// API (Dexscreener) for a pool-id hint. When that API returned no v4 pair, the
// fork suite never ran and no proof was produced — a third party could silently
// disable our fork evidence. This module adds a fallback that finds the same event
// using ONLY Base chain data.
//
// WHAT IS NOT HARDCODED. No pool id, PoolKey, block number or transaction hash is
// baked in as a result. The fallback derives a search floor from the token's own
// on-chain code, then reads the `Initialize` event's indexed currencies. The pool
// identity is taken FROM the log, and the Foundry suite still verifies it
// independently. A hint only narrows where to look; it is never the proof.
//
// FAILING HONESTLY. If log access is too restricted to find the event within the
// request budget, these functions return null and the caller exits non-zero
// claiming no proof. A missing hint is never converted into a fabricated fixture.

export const V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
export const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000';
export const BASE_WETH = '0x4200000000000000000000000000000000000006';

/** Left-pads an address into an indexed-topic word. */
export const wordAddress = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

const hex = (n) => '0x' + BigInt(n).toString(16);

/**
 * Decodes a V4 `Initialize` log into a fork fixture, or null if it is not an
 * MPGR pair against native ETH or WETH.
 * Signature: Initialize(bytes32 id, address currency0, address currency1,
 *   uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
 * id/currency0/currency1 are indexed (topics 1..3); the rest is in data.
 */
export function decodeInitializeLog(log, { token, acceptableCounters = [NATIVE_CURRENCY, BASE_WETH] }) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 4) return null;
  const c0 = '0x' + String(log.topics[2]).slice(-40).toLowerCase();
  const c1 = '0x' + String(log.topics[3]).slice(-40).toLowerCase();
  const mpgr = token.toLowerCase();
  if (![c0, c1].includes(mpgr)) return null;
  const other = c0 === mpgr ? c1 : c0;
  if (!acceptableCounters.map((a) => a.toLowerCase()).includes(other)) return null;
  const words = String(log.data ?? '').slice(2).match(/.{64}/g);
  if (!words || words.length < 3) return null;
  return {
    currency0: c0,
    currency1: c1,
    fee: Number(BigInt('0x' + words[0])),
    tickSpacing: Number(BigInt('0x' + words[1])),
    hooks: '0x' + words[2].slice(-40),
    poolId: log.topics[1],
    initializeBlock: Number(log.blockNumber),
    initializeTx: log.transactionHash,
  };
}

/**
 * Binary-searches the first block at which `token` has runtime code. Chain-derived
 * and monotonic (a deployed token keeps its code), so this is a sound lower bound
 * for any pool initialization involving that token. Uses only eth_getCode, which
 * is not subject to eth_getLogs range caps.
 */
export async function findTokenDeploymentBlock(rpc, { token, latest, earliest = 0, maxSteps = 64 }) {
  const hasCode = async (block) => {
    const code = await rpc('eth_getCode', [token, hex(block)]);
    return typeof code === 'string' && code !== '0x' && code !== '0x0' && code.length > 2;
  };
  if (!(await hasCode(latest))) return null;
  if (await hasCode(earliest)) return earliest;
  let low = earliest;
  let high = latest;
  let steps = 0;
  while (low < high && steps++ < maxSteps) {
    const mid = Math.floor((low + high) / 2);
    if (await hasCode(mid)) high = mid; else low = mid + 1;
  }
  return low;
}

/** Default probe offsets around a timestamp-derived block, in 10-block windows. */
export const WINDOW_OFFSETS = [0, -10, 10, -20, 20, -30, 30, -40, 40, -50, 50, -60, 60, -70, 70, -80, 80, -90, 90, -100, 100];

/**
 * The original hint-driven search: given a poolId and its creation timestamp,
 * binary-search the block by timestamp, then probe nearby 10-block windows for
 * the Initialize event carrying that poolId.
 */
export async function findInitializeByPoolId(rpc, {
  manager = V4_POOL_MANAGER, topic, poolId, timestamp, latest, offsets = WINDOW_OFFSETS, log = () => {},
}) {
  if (!timestamp) return null;
  let low = 0;
  let high = latest;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const b = await rpc('eth_getBlockByNumber', [hex(mid), false]);
    if (Number(b.timestamp) < timestamp) low = mid + 1; else high = mid;
  }
  for (const offset of offsets) {
    const from = Math.max(0, low - 4 + offset);
    const to = Math.min(latest, from + 9);
    const logs = await rpc('eth_getLogs', [{ address: manager, fromBlock: hex(from), toBlock: hex(to), topics: [topic, poolId] }]);
    if (Array.isArray(logs) && logs.length) {
      log(`poolId hint matched at blocks ${from}-${to}`);
      return logs;
    }
  }
  return null;
}

/**
 * Hint-free fallback: find the Initialize event by its INDEXED CURRENCIES.
 *
 * The pool id is not known in advance and is not needed — `Initialize` indexes
 * currency0 and currency1, so querying `topics: [sig, null, word(token)]` (and the
 * currency1 position) returns exactly the pools that involve MPGR. The pool id is
 * then read from the matched log itself.
 *
 * Strategy, in order:
 *  1. One wide-range query per currency position. A capable RPC answers this in a
 *     single request, which is the common case when BASE_MAINNET_RPC_URL is set.
 *  2. If the RPC caps the range, or returns nothing, degrade to 10-block windows
 *     scanning forward from the chain-derived floor, up to `maxWindows`.
 *  3. Still nothing -> null. The caller must fail honestly; we never invent a pool.
 */
export async function findInitializeByCurrency(rpc, {
  manager = V4_POOL_MANAGER, topic, token, fromBlock, latest, maxWindows = 4000, log = () => {},
}) {
  const positions = [
    [topic, null, wordAddress(token)],
    [topic, null, null, wordAddress(token)],
  ];
  // 1. Wide range first: cheapest and most complete when the RPC allows it.
  for (const topics of positions) {
    try {
      const logs = await rpc('eth_getLogs', [{ address: manager, fromBlock: hex(fromBlock), toBlock: hex(latest), topics }]);
      if (Array.isArray(logs) && logs.length) {
        log(`wide-range currency search matched ${logs.length} Initialize log(s)`);
        return logs;
      }
    } catch (error) {
      // A range cap is expected on free-tier plans; fall through to windowing.
      log(`wide-range query refused (${String(error?.message ?? error).slice(0, 140)}); falling back to windowed scan`);
    }
  }
  // 2. Windowed scan forward from the token's deployment block.
  let windows = 0;
  for (let from = fromBlock; from <= latest && windows < maxWindows; from += 10) {
    const to = Math.min(latest, from + 9);
    for (const topics of positions) {
      let logs;
      try {
        logs = await rpc('eth_getLogs', [{ address: manager, fromBlock: hex(from), toBlock: hex(to), topics }]);
      } catch {
        // One failed window is not proof of absence; keep scanning.
        continue;
      }
      windows++;
      if (Array.isArray(logs) && logs.length) {
        log(`windowed currency search matched at blocks ${from}-${to} after ${windows} window(s)`);
        return logs;
      }
    }
  }
  log(`currency search exhausted ${windows} window(s) from block ${fromBlock} without a match`);
  return null;
}
