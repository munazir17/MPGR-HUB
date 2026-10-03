#!/usr/bin/env node
// scripts/mainnet-canary-preflight.mjs
//
// MAINNET CANARY PREFLIGHT — strictly READ-ONLY (eth_call/eth_getCode/
// eth_getBalance/eth_chainId). Nothing is signed or broadcast. Run by the
// `mainnet-canary.yml` preflight job and by the operator before arming.
//
// Required config (GitHub/CI environment only — NEVER Vercel/app env):
//   BASE_MAINNET_RPC_URL  dedicated Mainnet RPC (falls back to publicnode)
//   CANARY_ADDRESS        (optional) address of the dedicated canary key, so
//                         balances/allowance can be verified pre-arm
//
// Exit 0 iff every hard check passes.
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { readFileSync } from "node:fs";

const RPC = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-rpc.publicnode.com";
const CANARY_ADDRESS = process.env.CANARY_ADDRESS?.trim() || "";

// Pinned facts (single source: lib/executor/executor-config.ts; the 13 stock
// addresses are parsed from test/fork/B20StockBytecodeFork.t.sol, which §G pins
// to the TS registry).
const EXECUTOR = "0xD982726e28275661F8aB64054E6b17a70a63505A";
const OWNER = "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e";
const FEE_RECIPIENT = "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";
const SLIP_FACTORY = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";
const SLIP_QUOTER = "0x514c8B5f54112481E28028F1166Bd78501089259";
const CANARY_GROSS = 1_000_000n; // 1.00 USDC

const erc20Abi = [{
  type: "function", name: "decimals", stateMutability: "view",
  inputs: [], outputs: [{ type: "uint8" }],
}];

function fail(msg) {
  console.error(`::error::PREFLIGHT ${msg}`);
  process.exitCode = 1;
}
function pass(msg) {
  console.log(`PASS ${msg}`);
}

const client = createPublicClient({ chain: base, transport: http(RPC) });

// --- the 13 stock addresses come from the fork bytecode proof (F-13) --------
const sol = readFileSync("test/fork/B20StockBytecodeFork.t.sol", "utf8");
const decls = [...sol.matchAll(/address internal constant (\w+c) = (0x[bB]20[0-9a-fA-F]{37});/g)];
if (decls.length !== 13) fail(`stock list parse: expected 13, got ${decls.length}`);
const STOCKS = decls.map((m) => ({ symbol: m[1], address: m[2] }));

async function main() {
  // 1) chain
  const chainId = await client.getChainId();
  if (chainId !== 8453) return fail(`chainId ${chainId} != 8453 — refusing to preflight anything else`);
  pass("chain is Base Mainnet (8453)");

  // 2) executor live config
  const [owner, feeRecipient, feeBps, paused] = await Promise.all([
    client.readContract({ address: EXECUTOR, abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "owner" }),
    client.readContract({ address: EXECUTOR, abi: [{ type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "feeRecipient" }),
    client.readContract({ address: EXECUTOR, abi: [{ type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }], functionName: "feeBps" }),
    client.readContract({ address: EXECUTOR, abi: [{ type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }], functionName: "paused" }),
  ]);
  if (String(owner).toLowerCase() !== OWNER) return fail(`executor owner ${owner} != pinned ${OWNER}`);
  if (String(feeRecipient).toLowerCase() !== FEE_RECIPIENT) return fail(`feeRecipient ${feeRecipient} != pinned`);
  if (Number(feeBps) !== 25) return fail(`feeBps ${feeBps} != 25`);
  if (paused === true) return fail("executor is PAUSED by its owner — cannot canary");
  pass("executor owner/feeRecipient/feeBps(25)/not-paused match pins");

  // 3) bytecode: executor + Permit2 + USDC + WETH + all 13 stocks (F-13)
  for (const [label, addr] of [["executor", EXECUTOR], ["Permit2", PERMIT2], ["USDC", USDC], ["WETH", WETH], ...STOCKS.map((s) => [s.symbol, s.address])]) {
    const code = await client.getBytecode({ address: addr });
    if (!code || code === "0x") return fail(`${label} has NO code at ${addr}`);
  }
  pass("bytecode present: executor, Permit2, USDC, WETH, 13/13 stocks");

  // 4) decimals snapshot
  const usdcD = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "decimals" });
  const wethD = await client.readContract({ address: WETH, abi: erc20Abi, functionName: "decimals" });
  if (Number(usdcD) !== 6 || Number(wethD) !== 18) return fail(`USDC/WETH decimals ${usdcD}/${wethD} != 6/18`);
  for (const s of STOCKS) {
    const d = await client.readContract({ address: s.address, abi: erc20Abi, functionName: "decimals" });
    if (Number(d) !== 8) return fail(`${s.symbol} decimals ${d} != 8`);
  }
  pass("decimals: USDC 6, WETH 18, stocks 8/8/…/8");

  // 5) canary route liveness: USDC/AAPLc Slipstream pool + sane quote (hard)
  const aapl = STOCKS.find((s) => s.symbol === "AAPLc");
  if (!aapl) return fail("AAPLc missing from the stock list");
  const pool = await client.readContract({
    address: SLIP_FACTORY,
    abi: [{ type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "int24" }], outputs: [{ type: "address" }] }],
    functionName: "getPool",
    args: [USDC, aapl.address, 10],
  });
  if (!pool || pool === "0x0000000000000000000000000000000000000000") return fail("USDC/AAPLc tick-10 Slipstream pool EMPTY");
  const quote = await client.readContract({
    address: SLIP_QUOTER,
    abi: [{
      type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
      inputs: [{ name: "params", type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "tickSpacing", type: "int24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
      outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" }, { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }],
    }],
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: USDC, tokenOut: aapl.address, amountIn: CANARY_GROSS, tickSpacing: 10, sqrtPriceLimitX96: 0n }],
  });
  const amountOut = Array.isArray(quote) ? quote[0] : 0n;
  // Sanity band: 1 USDC must buy between 0.0001 and 1 AAPLc (8 decimals) —
  // catches inverted/misrouted pairs while tolerating normal price moves.
  if (amountOut < 10_000n || amountOut > 100_000_000n) {
    return fail(`1 USDC -> AAPLc quote ${amountOut} outside sanity band [10_000, 100_000_000] raw`);
  }
  pass(`live route OK: 1 USDC -> AAPLc pool ${pool} quote ${amountOut} raw`);

  // 6) canary wallet (optional CANARY_ADDRESS): separation + funding + allowance
  if (CANARY_ADDRESS) {
    const ca = CANARY_ADDRESS.toLowerCase();
    if (ca === OWNER.toLowerCase() || ca === FEE_RECIPIENT.toLowerCase() || ca === EXECUTOR.toLowerCase()) {
      return fail("canary address must be SEPARATE from owner/feeRecipient/executor");
    }
    const sepoliaBroadcaster = process.env.SEPOLIA_BROADCASTER_ADDRESS?.trim().toLowerCase();
    if (sepoliaBroadcaster && ca === sepoliaBroadcaster) {
      return fail("canary address equals the SEPOLIA broadcaster address — a DEDICATED Mainnet canary key is required");
    }
    const eth = await client.getBalance({ address: CANARY_ADDRESS });
    if (eth < 10n ** 14n) return fail(`canary ETH ${eth} wei < 10^14 (gas for the single tx)`);
    const bal = await client.readContract({ address: USDC, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [CANARY_ADDRESS] });
    if (bal < CANARY_GROSS) return fail(`canary USDC ${bal} < ${CANARY_GROSS}`);
    const allow = await client.readContract({ address: USDC, abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "allowance", args: [CANARY_ADDRESS, EXECUTOR] });
    if (allow < CANARY_GROSS) {
      return fail(`canary USDC allowance ${allow} < ${CANARY_GROSS} — execute the preflight approval FIRST so the canary is exactly ONE transaction`);
    }
    pass(`canary wallet funded + pre-approved (ETH ${eth}, USDC ${bal}, allowance ${allow})`);
  } else {
    console.log("SKIP canary-wallet checks (CANARY_ADDRESS not set)");
  }

  console.log(process.exitCode ? "PREFLIGHT FAILED" : "PREFLIGHT PASSED (read-only; nothing broadcast)");
}

main().catch((e) => {
  fail(`preflight threw: ${e?.message ?? e}`);
});
