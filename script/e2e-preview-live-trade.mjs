#!/usr/bin/env node
// script/e2e-preview-live-trade.mjs
//
// REAL end-to-end trade through the deployed Preview MCP endpoint on Base SEPOLIA.
// Nothing here is simulated:
//   1. generate a brand-new throwaway wallet IN MEMORY (key never printed, stored or sent);
//   2. fund it with a tiny amount of Base Sepolia ETH from the CI-only deployer key;
//   3. Preview /api/mcp: get_quote (ETH -> tUSD) -> prepare_trade;
//   4. the throwaway wallet validates the unsigned tx, signs it locally and broadcasts it;
//   5. wait for the real receipt -> get_trade_status -> verify_trade;
//   6. independently confirm: trade ID (intentId), exact 25 bps fee credited to the fee
//      recipient within the swap tx (balance delta at that block), and no separate fee tx;
//   7. sweep leftover ETH back to the deployer.
// Hard guards: aborts before signing unless the RPC chain is 84532 and the prepared tx
// targets the deployed executor with exactly the quoted value/recipient/trade ID/fee.
//
// Env: PREVIEW_URL, FUNDER_PRIVATE_KEY (CI secret), BASE_SEPOLIA_RPC_URL,
//      VERCEL_AUTOMATION_BYPASS_SECRET, E2E_LIVE_JSON / E2E_LIVE_MD.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_EXECUTOR = "0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4";
const EXPECTED_FEE_RECIPIENT = "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4";
const SELL_WEI = 200_000_000_000_000n; // 0.0002 ETH
const EXPECTED_FEE = (SELL_WEI * 25n) / 10_000n; // 500_000_000_000 wei
const PREVIEW_URL = (process.env.PREVIEW_URL ?? "").replace(/\/$/, "");
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || "";
const OUT_JSON = process.env.E2E_LIVE_JSON || "e2e-live-results.json";
const OUT_MD = process.env.E2E_LIVE_MD || "e2e-live-report.md";
const EXPLORER = "https://sepolia.basescan.org";

const REC = JSON.parse(readFileSync(path.join(ROOT, "deployments/base-sepolia/mpgr-executor.json"), "utf8"));
const abiSrc = readFileSync(path.join(ROOT, "lib/executor/mpgr-executor-abi.ts"), "utf8");
const EXEC_ABI = JSON.parse(abiSrc.slice(abiSrc.indexOf("["), abiSrc.lastIndexOf("]") + 1));
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);

const lc = (a) => String(a).toLowerCase();
const same = (a, b) => typeof a === "string" && typeof b === "string" && lc(a) === lc(b);
const intentIdOf = (quoteId) => keccak256(stringToHex(`mpgr-executor-intent:${quoteId}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

const results = [];
const facts = {};
function check(name, ok, detail = "") {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail, big);
  results.push({ name, ok: Boolean(ok), detail: d });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${d ? ` — ${d}` : ""}`);
  return Boolean(ok);
}
class Abort extends Error {}
/** Load-balanced public RPC backends can lag: retry block-pinned reads until served. */
async function retry(label, fn, tries = 15) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(3000);
    }
  }
  throw new Error(`${label}: ${String(last?.shortMessage ?? last?.message ?? last).slice(0, 200)}`);
}
/** Runs an independent verification section; an RPC error fails that section only. */
async function section(label, fn) {
  try {
    await fn();
  } catch (e) {
    check(`${label} (section error)`, false, String(e?.shortMessage ?? e?.message ?? e).slice(0, 300));
  }
}
function must(name, ok, detail) {
  if (!check(name, ok, detail)) throw new Abort(`aborted at: ${name}`);
}

// ------------------------------------------------------------------ MCP transport
let rpcId = 0;
async function mcp(method, params) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" };
  if (BYPASS) headers["x-vercel-protection-bypass"] = BYPASS;
  const res = await fetch(`${PREVIEW_URL}/api/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}
async function tool(name, args) {
  const r = await mcp("tools/call", { name, arguments: args });
  const result = r.json?.result;
  return { http: r.status, isError: result?.isError === true, data: result?.structuredContent ?? null, raw: r.text };
}
const errCode = (t) => t.data?.error?.code ?? `http ${t.http}`;

// ------------------------------------------------------------------ run
let sweepCtx = null;
/** Always runs once the throwaway wallet was funded: return leftover ETH to the funder. */
async function sweep() {
  if (!sweepCtx) return;
  const { walletClient, wallet, funder } = sweepCtx;
  try {
    const bal = await pub.getBalance({ address: wallet.address, blockTag: "pending" });
    const fees = await pub.estimateFeesPerGas();
    const cost = fees.maxFeePerGas * 21_000n;
    if (bal <= cost * 2n) {
      facts.sweepTx = `nothing to sweep (${bal} wei)`;
      return;
    }
    const h = await walletClient.sendTransaction({ to: funder.address, value: bal - cost, gas: 21_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
    facts.sweepTx = h;
  } catch (e) {
    facts.sweepTx = `sweep failed (dust left in throwaway): ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`;
  }
}

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL, { retryCount: 3, timeout: 30_000 }) });

async function main() {
  if (!PREVIEW_URL) throw new Abort("PREVIEW_URL missing");
  const funderKey = process.env.FUNDER_PRIVATE_KEY?.trim();
  if (!funderKey) throw new Abort("FUNDER_PRIVATE_KEY (CI deployer secret) not available to this job");

  must("RPC chainId == 84532 (Base Sepolia; never mainnet)", (await pub.getChainId()) === 84532, String(await pub.getChainId()));
  must("record executor == 0xDFcB…76C4 and fee recipient == 0x96F7…64A4", same(REC.executor, EXPECTED_EXECUTOR) && same(REC.feeRecipient, EXPECTED_FEE_RECIPIENT), "");
  const onFeeRecipient = await pub.readContract({ address: EXPECTED_EXECUTOR, abi: EXEC_ABI, functionName: "feeRecipient" });
  const onFeeBps = await pub.readContract({ address: EXPECTED_EXECUTOR, abi: EXEC_ABI, functionName: "feeBps" });
  must("on-chain executor feeRecipient == 0x96F7…64A4, feeBps == 25", same(onFeeRecipient, EXPECTED_FEE_RECIPIENT) && Number(onFeeBps) === 25, `${onFeeRecipient} / ${onFeeBps}`);

  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mpgr-e2e-live", version: "1" } });
  must("Preview /api/mcp initialize -> 200", init.status === 200 && init.json?.result?.serverInfo?.name === "mpgr-agent", `HTTP ${init.status}`);

  // 1. Throwaway wallet (in memory only).
  const walletKey = generatePrivateKey();
  const wallet = privateKeyToAccount(walletKey);
  facts.throwawayWallet = wallet.address;
  const funder = privateKeyToAccount(funderKey);
  facts.funder = funder.address;
  must("throwaway wallet is fresh (nonce 0, balance 0)", (await pub.getTransactionCount({ address: wallet.address })) === 0 && (await pub.getBalance({ address: wallet.address })) === 0n, wallet.address);
  must("throwaway wallet is not the owner / fee recipient / funder", ![REC.owner, EXPECTED_FEE_RECIPIENT, funder.address].some((a) => same(a, wallet.address)), "");

  // 2. Fund: sell amount + generous gas budget (Base Sepolia gas is cheap).
  const gasPrice = await pub.getGasPrice();
  const gasBudget = gasPrice * 2n * 600_000n + 20_000_000_000_000n; // 2x price * 600k gas + 0.00002 ETH headroom
  const fundWei = SELL_WEI + gasBudget;
  const funderBal = await pub.getBalance({ address: funder.address });
  facts.funderBalanceBefore = formatEther(funderBal);
  must("CI funder has enough Base Sepolia ETH", funderBal > fundWei + gasPrice * 2n * 21_000n, `${formatEther(funderBal)} ETH, need ~${formatEther(fundWei)}`);
  const funderClient = createWalletClient({ account: funder, chain: baseSepolia, transport: http(RPC_URL) });
  sweepCtx = { walletClient: createWalletClient({ account: wallet, chain: baseSepolia, transport: http(RPC_URL) }), wallet, funder };
  const fundHash = await funderClient.sendTransaction({ to: wallet.address, value: fundWei });
  facts.fundingTx = fundHash;
  const fundRcpt = await pub.waitForTransactionReceipt({ hash: fundHash, timeout: 120_000 });
  must("funding tx confirmed", fundRcpt.status === "success", `${fundHash} (${formatEther(fundWei)} ETH)`);
  for (let i = 0; i < 10 && (await pub.getBalance({ address: wallet.address })) < fundWei; i++) await sleep(1500);

  // 3. Quote + prepare on the Preview.
  const q = await tool("mpgr_get_quote", { taker: wallet.address, sellToken: "ETH", buyToken: "tUSD", sellAmount: SELL_WEI.toString() });
  must("Preview get_quote ETH -> tUSD", !q.isError && q.data?.quoteId, q.isError ? errCode(q) : "");
  const Q = q.data;
  facts.quoteId = Q.quoteId;
  facts.intentId = Q.intentId;
  facts.quote = { chainId: Q.chainId, executor: Q.executor, sellAmount: Q.sellAmount, feeBps: Q.feeBps, feeAmount: Q.feeAmount, feeRecipient: Q.feeRecipient, expectedBuyAmount: Q.expectedBuyAmount, minBuyAmount: Q.minBuyAmount };
  must("quote on chain 84532 via executor 0xDFcB…76C4", Q.chainId === 84532 && Q.executor === EXPECTED_EXECUTOR && Q.route?.executor === EXPECTED_EXECUTOR, `${Q.chainId} ${Q.executor}`);
  must("quote fee == 25 bps of 0.0002 ETH = 500000000000 wei, to 0x96F7…64A4, in ETH", Q.feeBps === 25 && Q.feeAmount === EXPECTED_FEE.toString() && same(Q.feeRecipient, EXPECTED_FEE_RECIPIENT) && Q.feeToken === "ETH", `${Q.feeAmount} -> ${Q.feeRecipient}`);
  must("quote intentId == keccak256('mpgr-executor-intent:'+quoteId)", Q.intentId === intentIdOf(Q.quoteId), Q.intentId);
  must("quote sees funded throwaway balance", Q.balanceSufficient === true, `takerBalance=${Q.takerBalance}`);

  const p = await tool("mpgr_prepare_trade", { quoteId: Q.quoteId });
  must("Preview prepare_trade", !p.isError && p.data?.transactionRequest, p.isError ? errCode(p) : "");
  const tx = p.data.transactionRequest;
  must("prepared: single step, no approval (native ETH sell)", p.data.steps.length === 1 && p.data.steps[0].step === "sendSwapTransaction", `${p.data.steps.length} steps`);
  must("prepared tx is unsigned {chainId,to,data,value}", Object.keys(tx).sort().join(",") === "chainId,data,to,value", Object.keys(tx).join(","));
  must("prepared tx: to == executor, chainId 84532, value == 0.0002 ETH", tx.to === EXPECTED_EXECUTOR && tx.chainId === 84532 && tx.value === SELL_WEI.toString(), JSON.stringify({ to: tx.to, chainId: tx.chainId, value: tx.value }));
  const dec = decodeFunctionData({ abi: EXEC_ABI, data: tx.data });
  const [sp, poolFee, auth] = dec.args;
  must(
    "calldata matches quote: tokenIn WETH, tokenOut tUSD, gross, fee, minOut, recipient = throwaway, intentId",
    dec.functionName === "swapUniswapV3ExactInputSingle" && poolFee === 3000 && Number(auth.kind) === 0 && same(sp.tokenIn, REC.weth) && same(sp.tokenOut, REC.testTokenUSD) && sp.grossAmountIn === SELL_WEI && sp.expectedFeeAmount === EXPECTED_FEE && sp.amountOutMinimum === BigInt(Q.minBuyAmount) && same(sp.recipient, wallet.address) && sp.intentId === Q.intentId && same(sp.router, REC.uniswapV3SwapRouter02),
    JSON.stringify(sp, big),
  );

  // 4. Pre-trade state, then sign locally and broadcast from the throwaway wallet ONLY.
  const tUSD = getAddress(REC.testTokenUSD);
  const tusdBefore = await pub.readContract({ address: tUSD, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address] });
  const walletClient = createWalletClient({ account: wallet, chain: baseSepolia, transport: http(RPC_URL) });
  const swapHash = await walletClient.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
  facts.swapTx = swapHash;
  console.log(`broadcast swap ${swapHash}`);

  // 5. Real receipt.
  const rcpt = await pub.waitForTransactionReceipt({ hash: swapHash, timeout: 180_000 });
  facts.swapBlock = rcpt.blockNumber.toString();
  must("swap receipt: status success", rcpt.status === "success", `block ${rcpt.blockNumber}, gasUsed ${rcpt.gasUsed}`);
  const sent = await pub.getTransaction({ hash: swapHash });
  check("receipt tx: from throwaway, to executor, value 0.0002 ETH, chainId 84532", same(sent.from, wallet.address) && same(sent.to, EXPECTED_EXECUTOR) && sent.value === SELL_WEI && sent.chainId === 84532, JSON.stringify({ from: sent.from, to: sent.to, value: sent.value, chainId: sent.chainId }, big));

  // 6. MCP status + verify (server-side RPC may lag a few seconds behind ours).
  let st;
  for (let i = 0; i < 20; i++) {
    st = await tool("mpgr_get_trade_status", { txHash: swapHash });
    if (st.data?.status === "confirmed" || st.data?.status === "reverted") break;
    await sleep(3000);
  }
  facts.status = st.data;
  check("Preview get_trade_status == confirmed at the receipt's block", st.data?.status === "confirmed" && st.data?.blockNumber === rcpt.blockNumber.toString() && st.data?.chainId === 84532, JSON.stringify(st.data));

  let v;
  for (let i = 0; i < 10; i++) {
    v = await tool("mpgr_verify_trade", { quoteId: Q.quoteId, txHash: swapHash });
    if (!(v.isError && errCode(v) === "TX_NOT_FOUND")) break;
    await sleep(3000);
  }
  facts.verify = v.data;
  const vChecks = v.data?.checks ?? [];
  check("Preview verify_trade: verified == true", !v.isError && v.data?.verified === true, v.isError ? errCode(v) : `${vChecks.filter((c) => c.ok).length}/${vChecks.length} checks ok`);
  const failedChecks = vChecks.filter((c) => !c.ok);
  check("verify_trade: every check passed", vChecks.length > 0 && failedChecks.length === 0, failedChecks.map((c) => `${c.name}: expected ${c.expected} got ${c.actual}`).join("; ") || vChecks.map((c) => c.name).join(" | "));
  check("verify_trade event.intentId == quote trade ID", v.data?.event?.intentId === Q.intentId, v.data?.event?.intentId);

  // 7. Independent receipt analysis (wait until the RPC serves blocks past the swap block).
  await retry("rpc catch-up", async () => {
    if ((await pub.getBlockNumber()) < rcpt.blockNumber + 1n) throw new Error("rpc behind swap block");
  }, 40);
  const swaps = [];
  const transfers = [];
  for (const l of rcpt.logs) {
    try {
      const e = decodeEventLog({ abi: EXEC_ABI, data: l.data, topics: l.topics });
      if (e.eventName === "SwapExecuted" && same(l.address, EXPECTED_EXECUTOR)) swaps.push(e.args);
      continue;
    } catch {
      /* not executor */
    }
    try {
      const e = decodeEventLog({ abi: ERC20_ABI, data: l.data, topics: l.topics });
      if (e.eventName === "Transfer") transfers.push({ token: l.address, ...e.args });
    } catch {
      /* ignore */
    }
  }
  const ev = swaps[0];
  facts.swapExecuted = ev ?? null;
  check("receipt: exactly one SwapExecuted from the executor", swaps.length === 1, `${swaps.length}`);
  if (ev) {
    check("SwapExecuted.intentId == keccak256('mpgr-executor-intent:'+quoteId)", ev.intentId === intentIdOf(Q.quoteId), ev.intentId);
    check("SwapExecuted: taker = throwaway, tokenIn WETH, tokenOut tUSD, gross 0.0002 ETH", same(ev.taker, wallet.address) && same(ev.tokenIn, REC.weth) && same(ev.tokenOut, tUSD) && ev.grossAmountIn === SELL_WEI, "");
    check("SwapExecuted: feeAmount == 500000000000 wei (exact 25 bps), feeBps 25, feeRecipient 0x96F7…64A4", ev.feeAmount === EXPECTED_FEE && Number(ev.feeBps) === 25 && same(ev.feeRecipient, EXPECTED_FEE_RECIPIENT), `${ev.feeAmount} bps=${ev.feeBps} -> ${ev.feeRecipient}`);
    check("SwapExecuted: fee + swapAmountIn == gross", ev.feeAmount + ev.swapAmountIn === ev.grossAmountIn, `${ev.feeAmount}+${ev.swapAmountIn}`);
    check("SwapExecuted: amountOut >= quoted minBuyAmount", ev.amountOut >= BigInt(Q.minBuyAmount), `${ev.amountOut} >= ${Q.minBuyAmount}`);
    await section("tUSD received", async () => {
      const tusdAfter = await retry("tUSD balance", () => pub.readContract({ address: tUSD, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address], blockNumber: rcpt.blockNumber }));
      check("throwaway received exactly amountOut tUSD", tusdAfter - tusdBefore === ev.amountOut && transfers.some((t) => same(t.token, tUSD) && same(t.to, wallet.address) && t.value === ev.amountOut), `${tusdAfter - tusdBefore}`);
    });
  }

  // Fee actually paid: fee recipient's ETH balance delta across the swap block.
  const n = rcpt.blockNumber;
  let feeDelta = null;
  let otherTouching = null;
  await section("fee recipient balance delta", async () => {
    const feeBefore = await retry("fee recipient balance @n-1", () => pub.getBalance({ address: EXPECTED_FEE_RECIPIENT, blockNumber: n - 1n }));
    const feeAfter = await retry("fee recipient balance @n", () => pub.getBalance({ address: EXPECTED_FEE_RECIPIENT, blockNumber: n }));
    feeDelta = feeAfter - feeBefore;
    facts.feeRecipientDelta = feeDelta.toString();
    facts.feeRecipientBalance = { [`block ${n - 1n}`]: feeBefore.toString(), [`block ${n}`]: feeAfter.toString() };
  });
  await section("swap block transactions", async () => {
    const block = await retry("swap block", () => pub.getBlock({ blockNumber: n, includeTransactions: true }));
    otherTouching = block.transactions.filter((t) => t.hash !== swapHash && (same(t.to, EXPECTED_FEE_RECIPIENT) || same(t.from, EXPECTED_FEE_RECIPIENT)));
    facts.swapBlockTxCount = block.transactions.length;
  });
  check("fee recipient ETH balance rose by exactly 500000000000 wei in the swap block", feeDelta === EXPECTED_FEE, `delta ${feeDelta ?? "n/a"} wei (block ${n - 1n} -> ${n}); other txs touching recipient in block: ${otherTouching?.length ?? "n/a"}`);
  // Internal call trace (if the RPC exposes debug_traceTransaction).
  try {
    await sleep(2000);
    const res = await fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [swapHash, { tracer: "callTracer" }] }) });
    const j = await res.json();
    if (j.result) {
      const calls = [];
      const walk = (c) => {
        calls.push(c);
        (c.calls ?? []).forEach(walk);
      };
      walk(j.result);
      const feeCalls = calls.filter((c) => same(c.to, EXPECTED_FEE_RECIPIENT) && c.value && BigInt(c.value) > 0n);
      facts.feeInternalCalls = feeCalls.map((c) => ({ from: c.from, to: c.to, value: BigInt(c.value).toString(), type: c.type }));
      check("trace: executor -> fee recipient internal ETH transfer == fee (inside the swap tx)", feeCalls.length === 1 && same(feeCalls[0].from, EXPECTED_EXECUTOR) && BigInt(feeCalls[0].value) === EXPECTED_FEE, JSON.stringify(facts.feeInternalCalls));
    } else facts.trace = `debug_traceTransaction unavailable: ${j.error?.message ?? "no result"}`;
  } catch (e) {
    facts.trace = `debug_traceTransaction unavailable: ${String(e.message).slice(0, 120)}`;
  }
  // No separate fee transaction.
  let walletNonce = null;
  await section("throwaway nonce", async () => {
    walletNonce = await retry("nonce", () => pub.getTransactionCount({ address: wallet.address, blockTag: "latest" }));
  });
  check("no separate fee tx: throwaway wallet sent exactly ONE transaction (the swap)", walletNonce === 1, `nonce=${walletNonce}`);
  check("no separate fee tx: no other tx to/from the fee recipient in the swap block", Array.isArray(otherTouching) && otherTouching.length === 0, otherTouching ? otherTouching.map((t) => t.hash).join(",") || "none" : "n/a");
  check("no separate fee tx: fee credited by the swap tx itself (balance delta == fee, single tx)", feeDelta === EXPECTED_FEE && walletNonce === 1 && Array.isArray(otherTouching) && otherTouching.length === 0, "");
}

try {
  await main();
} catch (e) {
  check(e instanceof Abort ? String(e.message) : "run completed without an exception", false, e instanceof Abort ? "" : String(e?.shortMessage ?? e?.message ?? e).slice(0, 500));
}
await sweep();

const failed = results.filter((r) => !r.ok);
writeFileSync(OUT_JSON, JSON.stringify({ previewUrl: PREVIEW_URL, facts, results }, big, 2));
const link = (h) => (h && h.startsWith("0x") ? `[\`${h.slice(0, 10)}…${h.slice(-8)}\`](${EXPLORER}/tx/${h})` : String(h ?? "n/a"));
const md = [
  `<!-- mpgr-e2e-live-trade -->`,
  `### REAL Base Sepolia trade through Preview /api/mcp (${failed.length === 0 ? "all checks passed" : `${failed.length} FAILED`})`,
  ``,
  `| | |`,
  `|---|---|`,
  `| Endpoint | \`${PREVIEW_URL}/api/mcp\` |`,
  `| Executor | \`${EXPECTED_EXECUTOR}\` |`,
  `| Throwaway wallet (in-memory, key never logged) | \`${facts.throwawayWallet ?? "n/a"}\` |`,
  `| Funding tx (CI deployer → throwaway) | ${link(facts.fundingTx)} |`,
  `| **Swap tx (ETH → tUSD)** | ${link(facts.swapTx)} (block ${facts.swapBlock ?? "n/a"}) |`,
  `| Trade ID (intentId) | \`${facts.intentId ?? "n/a"}\` |`,
  `| Fee | ${facts.quote?.feeAmount ?? "n/a"} wei (25 bps of ${facts.quote?.sellAmount ?? "?"}) → \`${EXPECTED_FEE_RECIPIENT}\`; recipient balance delta in block: ${facts.feeRecipientDelta ?? "n/a"} wei |`,
  `| verify_trade | verified = ${facts.verify?.verified ?? "n/a"} |`,
  `| Sweep back to deployer | ${link(facts.sweepTx)} |`,
  ``,
  ...results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? `: \`${r.detail.slice(0, 260).replace(/`/g, "'")}\`` : ""}`),
  facts.trace ? `\n_Note: ${facts.trace}_` : "",
].join("\n");
writeFileSync(OUT_MD, md);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
