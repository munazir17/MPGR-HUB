#!/usr/bin/env node
// scripts/mainnet-canary-reconcile.mjs
//
// MAINNET CANARY RECONCILIATION — strictly READ-ONLY. Given the canary tx
// hash, re-proves every fact from the chain itself (receipt + executor event +
// balance deltas at the receipt block). Nothing is broadcast.
//
// Usage:
//   CANARY_TX_HASH=0x… node scripts/mainnet-canary-reconcile.mjs
//   node scripts/mainnet-canary-reconcile.mjs 0x…
// Env:
//   BASE_MAINNET_RPC_URL  dedicated Mainnet RPC (falls back to publicnode)
//   CANARY_ADDRESS        (optional) dedicated canary key address — when set,
//                         sender/taker/balance-delta checks are enforced
import { createPublicClient, decodeEventLog, http } from "viem";
import { base } from "viem/chains";

const TX = (process.env.CANARY_TX_HASH || process.argv[2] || "").trim();
const RPC = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-rpc.publicnode.com";
const CANARY_ADDRESS = process.env.CANARY_ADDRESS?.trim().toLowerCase() || "";

const EXECUTOR = "0xD982726e28275661F8aB64054E6b17a70a63505A";
const FEE_RECIPIENT = "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AAPLc = "0xb200000000000000000000C2e324d24d7eEcd1fb".toLowerCase();
const GROSS = 1_000_000n;
const FEE = 2_500n; // 1.00 USDC x 25 bps

const SWAP_EXECUTED_ABI = [{
  type: "event",
  name: "SwapExecuted",
  inputs: [
    { name: "taker", type: "address", indexed: true },
    { name: "router", type: "address", indexed: true },
    { name: "intentId", type: "bytes32", indexed: true },
    { name: "tokenIn", type: "address", indexed: false },
    { name: "tokenOut", type: "address", indexed: false },
    { name: "grossAmountIn", type: "uint256", indexed: false },
    { name: "feeAmount", type: "uint256", indexed: false },
    { name: "swapAmountIn", type: "uint256", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "feeRecipient", type: "address", indexed: false },
    { name: "feeBps", type: "uint16", indexed: false },
    { name: "routerKind", type: "uint8", indexed: false },
    { name: "flags", type: "uint8", indexed: false },
  ],
}];
const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

function fail(msg) {
  console.error(`::error::RECONCILE ${msg}`);
  process.exitCode = 1;
}

if (!/^0x[0-9a-fA-F]{64}$/.test(TX)) {
  fail(`CANARY_TX_HASH missing/invalid (${TX || "empty"}) — pass the canary tx hash.`);
  process.exit(process.exitCode || 1);
}

const client = createPublicClient({ chain: base, transport: http(RPC) });

async function balanceAt(token, holder, blockNumber) {
  return await client.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [holder], blockNumber });
}

async function main() {
  const receipt = await client.getTransactionReceipt({ hash: TX });
  if (receipt.status !== "success") return fail(`receipt status ${receipt.status} != success`);
  if (receipt.to?.toLowerCase() !== EXECUTOR.toLowerCase()) return fail(`tx.to ${receipt.to} != executor`);
  if (CANARY_ADDRESS && receipt.from.toLowerCase() !== CANARY_ADDRESS) return fail(`tx.from ${receipt.from} != canary address`);
  console.log(`PASS receipt success, to=executor, block=${receipt.blockNumber}`);

  let ev = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== EXECUTOR.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: SWAP_EXECUTED_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "SwapExecuted") { ev = decoded.args; break; }
    } catch { /* different executor event */ }
  }
  if (!ev) return fail("no SwapExecuted event emitted BY the executor in this receipt");
  const a = ev;
  const checks = [
    ["tokenIn == USDC", String(a.tokenIn).toLowerCase() === USDC],
    ["tokenOut == AAPLc", String(a.tokenOut).toLowerCase() === AAPLc],
    [`grossAmountIn == ${GROSS}`, a.grossAmountIn === GROSS],
    [`feeAmount == ${FEE} (exact 25 bps)`, a.feeAmount === FEE],
    ["feeAmount + swapAmountIn == gross", a.feeAmount + a.swapAmountIn === a.grossAmountIn],
    ["feeBps == 25", Number(a.feeBps) === 25],
    ["feeRecipient == pinned", String(a.feeRecipient).toLowerCase() === FEE_RECIPIENT.toLowerCase()],
    ["routerKind == 1 (Slipstream)", Number(a.routerKind) === 1],
    ["flags == 0 (ERC20->ERC20)", Number(a.flags) === 0],
    ["amountOut > 0", a.amountOut > 0n],
    ["intentId nonzero", a.intentId !== "0x" + "0".repeat(64)],
    ...(CANARY_ADDRESS ? [["taker == canary", String(a.taker).toLowerCase() === CANARY_ADDRESS]] : []),
  ];
  for (const [name, ok] of checks) {
    if (!ok) return fail(`event check FAILED: ${name}`);
    console.log(`PASS ${name}`);
  }

  if (CANARY_ADDRESS) {
    const n = receipt.blockNumber;
    const usdcBefore = await balanceAt(USDC, CANARY_ADDRESS, n - 1n);
    const usdcAfter = await balanceAt(USDC, CANARY_ADDRESS, n);
    const stockBefore = await balanceAt(AAPLc, CANARY_ADDRESS, n - 1n);
    const stockAfter = await balanceAt(AAPLc, CANARY_ADDRESS, n);
    if (usdcBefore - usdcAfter !== GROSS) return fail(`USDC delta ${usdcBefore - usdcAfter} != ${GROSS}`);
    if (stockAfter - stockBefore !== a.amountOut) return fail(`AAPLc delta ${stockAfter - stockBefore} != event amountOut ${a.amountOut}`);
    console.log(`PASS balances: USDC -${GROSS}, AAPLc +${a.amountOut} (exact, at block ${n})`);
  }

  console.log(`RECONCILED ${TX} taker=${a.taker} intentId=${a.intentId} amountOutRaw=${a.amountOut}`);
  console.log(process.exitCode ? "RECONCILIATION FAILED" : "RECONCILIATION PASSED (read-only)");
}

main().catch((e) => fail(`reconcile threw: ${e?.message ?? e}`));
