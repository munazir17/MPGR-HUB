#!/usr/bin/env node
// script/e2e-preview-mcp.mjs
//
// End-to-end verification of a DEPLOYED MPGR Agent MCP endpoint (Vercel Preview)
// against live Base Sepolia. Read-only, and it never broadcasts:
//   * talks to <PREVIEW_URL>/api/mcp exactly as an MCP client would (JSON-RPC over HTTP);
//   * cross-checks every answer against the committed deployment record and
//     direct Base Sepolia RPC reads;
//   * SIMULATES the unsigned transactions the server returns (eth_simulateV1 /
//     eth_call with state overrides) to prove they would execute and pay the exact fee;
//   * permit-mode finalize is exercised with a THROWAWAY wallet generated in this
//     process (unfunded, discarded at exit). It stands in for the user's wallet on
//     the client side. Its key never leaves this process and is never sent to the server.
//
// Env:
//   PREVIEW_URL (required)          e.g. https://<project>-git-<branch>.vercel.app
//   BASE_SEPOLIA_RPC_URL            runner-side RPC for cross-checks (default https://sepolia.base.org)
//   VERCEL_AUTOMATION_BYPASS_SECRET optional, only if Vercel Deployment Protection is on
//   E2E_RESULT_JSON / E2E_RESULT_MD output files (default e2e-results.json / e2e-report.md)
//
// Exit code 0 only if every check passed (checks marked "info" never fail the run).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseSignature,
  stringToHex,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_EXECUTOR = "0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4";
const EXPECTED_MAINNET_EXECUTOR = "0xD982726e28275661F8aB64054E6b17a70a63505A";
const BASE_MAINNET_WETH = "0x4200000000000000000000000000000000000006";
const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PREVIEW_URL = (process.env.PREVIEW_URL ?? "").replace(/\/$/, "");
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || "";
const OUT_JSON = process.env.E2E_RESULT_JSON || "e2e-results.json";
const OUT_MD = process.env.E2E_RESULT_MD || "e2e-report.md";
const PROTOCOL = "2025-06-18";

if (!PREVIEW_URL) {
  console.error("PREVIEW_URL is required");
  process.exit(2);
}

const REC = JSON.parse(readFileSync(path.join(ROOT, "deployments/base-sepolia/mpgr-executor.json"), "utf8"));
const abiSrc = readFileSync(path.join(ROOT, "lib/executor/mpgr-executor-abi.ts"), "utf8");
const EXEC_ABI = JSON.parse(abiSrc.slice(abiSrc.indexOf("["), abiSrc.lastIndexOf("]") + 1));

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL, { retryCount: 3, timeout: 30_000 }) });
const lc = (a) => String(a).toLowerCase();
const same = (a, b) => typeof a === "string" && typeof b === "string" && lc(a) === lc(b);
const intentIdOf = (quoteId) => keccak256(stringToHex(`mpgr-executor-intent:${quoteId}`));

// ------------------------------------------------------------------ results
const GROUPS = {
  endpoint: "1. MCP endpoint responds",
  chain: "2. Base Sepolia (84532) selected",
  executor: "3. Deployed executor selected",
  quote: "4. Quote works",
  prepare: "5. Prepare returns the correct unsigned tx",
  nosign: "6. No server-side keys / signing / broadcast",
  flow: "7. Finalize / status / verify",
  fee: "8. 25 bps fee exact",
  mainnet: "9. Base mainnet disabled",
};
const results = [];
function check(group, name, ok, detail = "", level = "check") {
  results.push({ group, name, ok: Boolean(ok), level, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  const tag = ok ? "PASS" : level === "info" ? "INFO" : "FAIL";
  console.log(`[${tag}] ${GROUPS[group]} :: ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  return Boolean(ok);
}
const info = (group, name, detail) => check(group, name, true, detail, "info");

// ------------------------------------------------------------------ transport
const rawResponses = [];
let rpcId = 0;
let bypassViaQuery = false;
function url(p) {
  if (!BYPASS || !bypassViaQuery) return `${PREVIEW_URL}${p}`;
  return `${PREVIEW_URL}${p}${p.includes("?") ? "&" : "?"}x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`;
}
function headers(extra = {}) {
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra };
  if (BYPASS) h["x-vercel-protection-bypass"] = BYPASS;
  return h;
}
async function post(body, extraHeaders = {}) {
  const res = await fetch(url("/api/mcp"), { method: "POST", headers: headers(extraHeaders), body: JSON.stringify(body) });
  const text = await res.text();
  rawResponses.push(text);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}
async function mcp(method, params) {
  return post({ jsonrpc: "2.0", id: ++rpcId, method, params }, { "MCP-Protocol-Version": PROTOCOL });
}
async function tool(name, args = {}) {
  const r = await mcp("tools/call", { name, arguments: args });
  const result = r.json?.result;
  return { http: r.status, isError: result?.isError === true, data: result?.structuredContent ?? null, rpcError: r.json?.error ?? null };
}
const errCode = (t) => t.data?.error?.code ?? t.rpcError?.message ?? `http ${t.http}`;

async function rpc(method, params) {
  const res = await fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

// ------------------------------------------------------------------ simulation
const slotBalance = (owner) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 0n]));
const slotAllowance = (owner, spender) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 1n]))]));
const word = (v) => toHex(v, { size: 32 });

/** Simulates `tx` from `from` on latest Base Sepolia state with overrides. Returns {ok, logs|null, returnData, error, method}. */
async function simulate(from, tx, overrides) {
  const call = { from, to: tx.to, data: tx.data, value: toHex(BigInt(tx.value ?? "0")) };
  try {
    const out = await rpc("eth_simulateV1", [{ blockStateCalls: [{ stateOverrides: overrides, calls: [call] }], validation: false, traceTransfers: true }, "latest"]);
    const c = out?.[0]?.calls?.[0];
    if (!c) throw new Error("empty eth_simulateV1 result");
    return { ok: c.status === "0x1", logs: c.logs ?? [], returnData: c.returnData, error: c.error?.message ?? null, method: "eth_simulateV1" };
  } catch (e) {
    try {
      const ret = await rpc("eth_call", [call, "latest", overrides]);
      return { ok: true, logs: null, returnData: ret, error: null, method: `eth_call (eth_simulateV1 unavailable: ${String(e.message).slice(0, 80)})` };
    } catch (e2) {
      return { ok: false, logs: null, returnData: null, error: String(e2.message).slice(0, 300), method: "eth_call" };
    }
  }
}
function decodeLogs(logs) {
  const out = { transfers: [], swaps: [] };
  for (const l of logs ?? []) {
    try {
      const ev = decodeEventLog({ abi: EXEC_ABI, data: l.data, topics: l.topics });
      if (ev.eventName === "SwapExecuted") out.swaps.push({ address: l.address, ...ev.args });
      continue;
    } catch {
      /* not an executor event */
    }
    try {
      const ev = decodeEventLog({ abi: ERC20_ABI, data: l.data, topics: l.topics });
      if (ev.eventName === "Transfer") out.transfers.push({ token: l.address, ...ev.args });
    } catch {
      /* ignore */
    }
  }
  return out;
}
/** Asserts a simulation paid exactly `fee` of `feeToken` to the fee recipient and emitted SwapExecuted for `intentId`. */
function checkSimulation(group, label, sim, { feeToken, fee, intentId, minOut, recipient, native }) {
  if (!check(group, `${label}: simulated tx succeeds (${sim.method})`, sim.ok, sim.error ?? "")) return;
  if (sim.logs === null) {
    const out = sim.returnData ? BigInt(sim.returnData) : 0n;
    check(group, `${label}: simulated amountOut >= minBuyAmount`, out >= BigInt(minOut), `${out} >= ${minOut}`);
    info("fee", `${label}: fee transfer not observable without eth_simulateV1 logs`, "calldata expectedFeeAmount is enforced on-chain by the executor");
    return;
  }
  const { transfers, swaps } = decodeLogs(sim.logs);
  const ev = swaps.find((s) => same(s.address, EXPECTED_EXECUTOR) && lc(s.intentId) === lc(intentId));
  check(group, `${label}: exactly one SwapExecuted for this intentId`, swaps.filter((s) => lc(s.intentId) === lc(intentId)).length === 1, `${swaps.length} SwapExecuted`);
  if (!ev) return;
  check("fee", `${label}: SwapExecuted.feeAmount == quoted fee`, ev.feeAmount === BigInt(fee), `${ev.feeAmount} vs ${fee}`);
  check("fee", `${label}: SwapExecuted.feeBps == 25`, Number(ev.feeBps) === 25, String(ev.feeBps));
  check("fee", `${label}: feeRecipient == record`, same(ev.feeRecipient, REC.feeRecipient), ev.feeRecipient);
  check("fee", `${label}: fee + swapAmountIn == gross`, ev.feeAmount + ev.swapAmountIn === ev.grossAmountIn, `${ev.feeAmount}+${ev.swapAmountIn}=${ev.grossAmountIn}`);
  check(group, `${label}: amountOut >= minBuyAmount`, ev.amountOut >= BigInt(minOut), `${ev.amountOut} >= ${minOut}`);
  check(group, `${label}: output recipient == taker`, same(ev.taker, recipient), ev.taker);
  if (native) {
    // traceTransfers reports native ETH moves as ERC-20-style Transfer logs from 0xEeee…EEeE.
    const eth = transfers.filter((t) => lc(t.token) === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" && same(t.to, REC.feeRecipient));
    if (eth.length) check("fee", `${label}: native ETH fee transfer to feeRecipient == fee`, eth.some((t) => t.value === BigInt(fee)), eth.map((t) => String(t.value)).join(","));
    else info("fee", `${label}: native fee transfer trace not returned by node`, "SwapExecuted fee fields verified above");
  } else {
    const ft = transfers.filter((t) => same(t.token, feeToken) && same(t.to, REC.feeRecipient));
    check("fee", `${label}: ERC-20 Transfer(feeRecipient) == exact fee`, ft.length === 1 && ft[0].value === BigInt(fee), ft.map((t) => String(t.value)).join(",") || "none");
  }
}

function decodeSwap(data) {
  const d = decodeFunctionData({ abi: EXEC_ABI, data });
  const [p, poolFee, auth] = d.args;
  return { fn: d.functionName, p, poolFee, auth };
}
function txKeysOk(tx) {
  return tx && Object.keys(tx).sort().join(",") === "chainId,data,to,value";
}

// ------------------------------------------------------------------ run
async function main() {
  const tUSD = getAddress(REC.testTokenUSD);
  const tSTOCK = getAddress(REC.testTokenStock);
  const WETH = getAddress(REC.weth);
  const ROUTER = getAddress(REC.uniswapV3SwapRouter02);
  const PERMIT2 = getAddress(REC.permit2);
  const QUOTER = getAddress(REC.uniswapV3QuoterV2);

  check("executor", "record executor == expected deployed address", same(REC.executor, EXPECTED_EXECUTOR), REC.executor);
  const chainId = await client.getChainId();
  check("chain", "runner RPC is Base Sepolia", chainId === 84532, String(chainId));

  // Funded taker for realistic quote/prepare: the deploy wallet that sent the recorded swaps.
  const swap0 = await client.getTransaction({ hash: REC.swaps[0].txHash });
  const DEPLOYER = getAddress(swap0.from);
  info("quote", "funded taker (deployer of the recorded swaps, read-only use)", DEPLOYER);
  const nonceBefore = { latest: await client.getTransactionCount({ address: DEPLOYER }), pending: await client.getTransactionCount({ address: DEPLOYER, blockTag: "pending" }) };

  // Direct on-chain truth.
  const [onOwner, onFeeRecipient, onFeeBps, onPaused, code] = await Promise.all([
    client.readContract({ address: EXPECTED_EXECUTOR, abi: EXEC_ABI, functionName: "owner" }),
    client.readContract({ address: EXPECTED_EXECUTOR, abi: EXEC_ABI, functionName: "feeRecipient" }),
    client.readContract({ address: EXPECTED_EXECUTOR, abi: EXEC_ABI, functionName: "feeBps" }),
    client.readContract({ address: EXPECTED_EXECUTOR, abi: EXEC_ABI, functionName: "paused" }),
    client.getCode({ address: EXPECTED_EXECUTOR }),
  ]);
  check("executor", "executor has code on Base Sepolia", code && code.length > 2, `${(code.length - 2) / 2} bytes`);
  check("executor", "on-chain owner == record", same(onOwner, REC.owner), onOwner);
  check("executor", "on-chain feeRecipient == record", same(onFeeRecipient, REC.feeRecipient), onFeeRecipient);
  check("fee", "on-chain feeBps() == 25", Number(onFeeBps) === 25, String(onFeeBps));
  check("executor", "executor not paused", onPaused === false, String(onPaused));

  // ---------------------------------------------------------------- 1. endpoint
  info("endpoint", "Vercel protection bypass secret available to this job", BYPASS ? `yes (length ${BYPASS.length}; value not logged)` : "NO (secret VERCEL_AUTOMATION_BYPASS_SECRET is empty/unset for this workflow)");
  const initBody = () => ({ jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "mpgr-e2e", version: "1" } } });
  let init = await post(initBody());
  if (init.status === 401 && BYPASS) {
    info("endpoint", "bypass header rejected (401); retrying with the query-parameter form", "");
    bypassViaQuery = true;
    init = await post(initBody());
  }
  if (!check("endpoint", "POST initialize -> HTTP 200 JSON-RPC", init.status === 200 && init.json?.result, `HTTP ${init.status} ${init.text.slice(0, 160).replace(/\s+/g, " ")}`)) {
    if (init.status === 401 || init.status === 403 || /vercel/i.test(init.text.slice(0, 2000))) {
      check("endpoint", "Preview is publicly reachable (Vercel Deployment Protection?)", false, "Set VERCEL_AUTOMATION_BYPASS_SECRET as a repo secret, or disable protection for Preview");
    }
    return;
  }
  info("endpoint", "served by", `x-vercel-id=${init.headers.get("x-vercel-id") ?? "?"}`);
  check("endpoint", "protocolVersion negotiated", init.json.result.protocolVersion === PROTOCOL, init.json.result.protocolVersion);
  check("endpoint", "serverInfo.name == mpgr-agent", init.json.result.serverInfo?.name === "mpgr-agent", JSON.stringify(init.json.result.serverInfo));
  check("nosign", "server instructions: never signs / never asks for keys", /never sign/i.test(init.json.result.instructions ?? "") && /private keys/i.test(init.json.result.instructions ?? ""), "");
  const notif = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "MCP-Protocol-Version": PROTOCOL });
  check("endpoint", "notification -> 202", notif.status === 202, `HTTP ${notif.status}`);
  const ping = await mcp("ping", {});
  check("endpoint", "ping", ping.status === 200 && ping.json?.result && Object.keys(ping.json.result).length === 0, `HTTP ${ping.status}`);
  const list = await mcp("tools/list", {});
  const names = (list.json?.result?.tools ?? []).map((t) => t.name).sort();
  const expectedTools = ["mpgr_finalize_trade", "mpgr_get_capabilities", "mpgr_get_quote", "mpgr_get_trade_status", "mpgr_list_tokens", "mpgr_prepare_trade", "mpgr_verify_trade"];
  check("endpoint", "tools/list returns the 7 MPGR tools", JSON.stringify(names) === JSON.stringify(expectedTools), names.join(","));
  check("nosign", "every tool is non-destructive", (list.json?.result?.tools ?? []).every((t) => t.annotations?.destructiveHint === false), "");
  const get = await fetch(url("/api/mcp"), { headers: headers() });
  check("endpoint", "GET /api/mcp -> 405 (stateless, POST only)", get.status === 405, `HTTP ${get.status}`);
  const evil = await post({ jsonrpc: "2.0", id: ++rpcId, method: "ping" }, { Origin: "https://evil.example" });
  check("endpoint", "foreign browser Origin rejected (403)", evil.status === 403, `HTTP ${evil.status}`);

  // ---------------------------------------------------------------- 2/3. capabilities + tokens
  const caps = await tool("mpgr_get_capabilities");
  const sep = caps.data?.chains?.find((c) => c.chainId === 84532);
  const main = caps.data?.chains?.find((c) => c.chainId === 8453);
  check("chain", "capabilities lists Base Sepolia first", caps.data?.chains?.[0]?.chainId === 84532, JSON.stringify(caps.data?.chains?.map((c) => c.chainId)));
  check("chain", "Base Sepolia tradingProviders == [mpgr-executor]", JSON.stringify(sep?.tradingProviders) === '["mpgr-executor"]', JSON.stringify(sep?.tradingProviders));
  check("executor", "capabilities executor.status == deployed", sep?.executor?.status === "deployed", sep?.executor?.status);
  check("executor", "capabilities executor.address == 0xDFcB…76C4", sep?.executor?.address === EXPECTED_EXECUTOR, sep?.executor?.address);
  check("executor", "capabilities owner == on-chain owner", same(sep?.executor?.owner, onOwner), sep?.executor?.owner);
  check("executor", "capabilities feeRecipient == on-chain feeRecipient", same(sep?.executor?.feeRecipient, onFeeRecipient), sep?.executor?.feeRecipient);
  check("executor", "capabilities deployTx == record", sep?.executor?.deployTx === REC.deployTx, sep?.executor?.deployTx);
  check("fee", "capabilities fee.bps == 25, maxBps == 100", caps.data?.fee?.bps === 25 && caps.data?.fee?.maxBps === 100, JSON.stringify({ bps: caps.data?.fee?.bps, max: caps.data?.fee?.maxBps }));
  check("nosign", "capabilities custody: never holds keys / signs / broadcasts", /never holds keys, never signs, never broadcasts/i.test(caps.data?.custody ?? ""), caps.data?.custody);
  check("mainnet", "capabilities 8453 executor.status == deployed (recorded fact)", main?.executor?.status === "deployed", main?.executor?.status);
  check("mainnet", "capabilities 8453 executor.address == 0xD982…505A", main?.executor?.address === EXPECTED_MAINNET_EXECUTOR, main?.executor?.address);
  check("mainnet", "capabilities 8453 tradingEnabled == false (flag off in preview)", main?.tradingEnabled === false, String(main?.tradingEnabled));
  check("mainnet", "capabilities 8453 tradingProviders == [] while the flag is off", Array.isArray(main?.tradingProviders) && main.tradingProviders.length === 0, JSON.stringify(main?.tradingProviders));

  const toks = await tool("mpgr_list_tokens");
  check("chain", "list_tokens default chainId == 84532", toks.data?.chainId === 84532, String(toks.data?.chainId));
  check("executor", "list_tokens executor == 0xDFcB…76C4", toks.data?.executor === EXPECTED_EXECUTOR, toks.data?.executor);
  check("executor", "list_tokens tokens == WETH,tUSD,tSTOCK", (toks.data?.tokens ?? []).map((t) => t.symbol).join(",") === "WETH,tUSD,tSTOCK", (toks.data?.tokens ?? []).map((t) => `${t.symbol}:${t.address}`).join(" "));

  // ---------------------------------------------------------------- 4. quote (funded taker, default chain)
  const qA = await tool("mpgr_get_quote", { taker: DEPLOYER, sellToken: "tUSD", buyToken: "tSTOCK", sellAmountHuman: "10" });
  if (!check("quote", "get_quote tUSD->tSTOCK 10 (no chainId given)", !qA.isError && qA.data?.quoteId, qA.isError ? errCode(qA) : "")) return;
  const A = qA.data;
  const nowS = Math.floor(Date.now() / 1000);
  check("chain", "quote.chainId == 84532 (default)", A.chainId === 84532, String(A.chainId));
  check("executor", "quote.executor == 0xDFcB…76C4", A.executor === EXPECTED_EXECUTOR && A.route?.executor === EXPECTED_EXECUTOR, `${A.executor} / route ${A.route?.executor}`);
  check("executor", "quote route: uniswap-v3 SwapRouter02, fee 3000", A.route?.venue === "uniswap-v3" && same(A.route?.router, ROUTER) && A.route?.poolFee === 3000, JSON.stringify(A.route));
  check("quote", "sellAmount == 10 tUSD (10000000)", A.sellAmount === "10000000", A.sellAmount);
  check("quote", "quoteId expires in <= 120s", A.expiresAt > nowS && A.expiresAt <= nowS + 125, `expiresAt-now=${A.expiresAt - nowS}s`);
  check("quote", "intentId == keccak256('mpgr-executor-intent:'+quoteId)", A.intentId === intentIdOf(A.quoteId), A.intentId);
  check("quote", "taker balance sufficient", A.balanceSufficient === true, `takerBalance=${A.takerBalance}`);
  const { result: onQuote } = await client.simulateContract({ address: QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn: tUSD, tokenOut: tSTOCK, amountIn: BigInt(A.swapAmount), fee: 3000, sqrtPriceLimitX96: 0n }] });
  const exp = BigInt(A.expectedBuyAmount);
  const drift = onQuote[0] > exp ? onQuote[0] - exp : exp - onQuote[0];
  check("quote", "expectedBuyAmount == live QuoterV2(swapAmount) (<=0.5% drift)", drift * 1000n <= exp * 5n, `server ${exp} vs chain ${onQuote[0]}`);
  check("quote", "minBuyAmount == expected * (10000-100)/10000", BigInt(A.minBuyAmount) === (exp * 9900n) / 10000n, `${A.minBuyAmount}`);
  check("fee", "quote feeBps == 25", A.feeBps === 25, String(A.feeBps));
  check("fee", "quote feeAmount == floor(10000000*25/10000) = 25000", A.feeAmount === "25000", A.feeAmount);
  check("fee", "quote swapAmount == gross - fee = 9975000", A.swapAmount === "9975000", A.swapAmount);
  check("fee", "fee token == sell token (tUSD), recipient == record", same(A.feeToken, tUSD) && same(A.feeRecipient, REC.feeRecipient), `${A.feeToken} -> ${A.feeRecipient}`);

  const qOdd = await tool("mpgr_get_quote", { taker: DEPLOYER, sellToken: tUSD, buyToken: tSTOCK, sellAmount: "12345677" });
  check("fee", "odd amount 12345677 -> fee floor = 30864", !qOdd.isError && qOdd.data?.feeAmount === "30864" && qOdd.data?.swapAmount === "12314813", qOdd.isError ? errCode(qOdd) : `${qOdd.data?.feeAmount}/${qOdd.data?.swapAmount}`);
  const qTiny = await tool("mpgr_get_quote", { taker: DEPLOYER, sellToken: "tUSD", buyToken: "tSTOCK", sellAmount: "1" });
  check("fee", "amount whose fee rounds to 0 is refused (no fee bypass)", qTiny.isError, qTiny.isError ? errCode(qTiny) : `accepted fee=${qTiny.data?.feeAmount}`);
  const qN = await tool("mpgr_get_quote", { taker: DEPLOYER, sellToken: "ETH", buyToken: "tUSD", sellAmountHuman: "0.0001" });
  check("quote", "get_quote native ETH -> tUSD", !qN.isError && qN.data?.sellNative === true, qN.isError ? errCode(qN) : "");
  check("fee", "native quote: fee in ETH = 250000000000 wei (25 bps of 1e14)", qN.data?.feeToken === "ETH" && qN.data?.feeAmount === "250000000000", `${qN.data?.feeToken} ${qN.data?.feeAmount}`);

  // ---------------------------------------------------------------- 5. prepare
  const pA = await tool("mpgr_prepare_trade", { quoteId: A.quoteId, authorization: "APPROVAL" });
  if (check("prepare", "prepare APPROVAL", !pA.isError, pA.isError ? errCode(pA) : "")) {
    const allowance = await client.readContract({ address: tUSD, abi: ERC20_ABI, functionName: "allowance", args: [DEPLOYER, EXPECTED_EXECUTOR] });
    const ap = pA.data.steps.find((s) => s.step === "sendApprovalTransaction");
    check("prepare", "approval step present iff on-chain allowance < gross", Boolean(ap) === allowance < 10_000_000n, `allowance=${allowance}`);
    if (ap) {
      const t = ap.transactionRequest;
      const d = decodeFunctionData({ abi: ERC20_ABI, data: t.data });
      check("prepare", "approval tx: tUSD.approve(executor, EXACT 10000000), value 0, chain 84532", same(t.to, tUSD) && d.functionName === "approve" && same(d.args[0], EXPECTED_EXECUTOR) && d.args[1] === 10_000_000n && t.value === "0" && t.chainId === 84532, `${d.functionName}(${d.args.join(",")})`);
      check("nosign", "approval tx is unsigned {chainId,to,data,value} only", txKeysOk(t), Object.keys(t).join(","));
    }
    const tx = pA.data.transactionRequest;
    check("nosign", "swap tx is unsigned {chainId,to,data,value} only", txKeysOk(tx), Object.keys(tx ?? {}).join(","));
    check("prepare", "swap tx.to == 0xDFcB…76C4, chainId 84532, value 0", tx?.to === EXPECTED_EXECUTOR && tx?.chainId === 84532 && tx?.value === "0", JSON.stringify({ to: tx?.to, chainId: tx?.chainId, value: tx?.value }));
    const s = decodeSwap(tx.data);
    check("prepare", "calldata = swapUniswapV3ExactInputSingle(poolFee 3000)", s.fn === "swapUniswapV3ExactInputSingle" && s.poolFee === 3000, `${s.fn} fee=${s.poolFee}`);
    check("prepare", "params: router/tokenIn/tokenOut/gross/minOut/recipient/deadline/intentId match quote", same(s.p.router, ROUTER) && same(s.p.tokenIn, tUSD) && same(s.p.tokenOut, tSTOCK) && s.p.grossAmountIn === 10_000_000n && s.p.amountOutMinimum === BigInt(A.minBuyAmount) && same(s.p.recipient, DEPLOYER) && s.p.deadline === BigInt(pA.data.intent.deadline) && s.p.intentId === A.intentId && s.p.unwrapNativeOut === false, JSON.stringify(s.p, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    check("fee", "calldata expectedFeeAmount == 25000", s.p.expectedFeeAmount === 25_000n, String(s.p.expectedFeeAmount));
    check("prepare", "auth = APPROVAL (kind 0, empty signature)", Number(s.auth.kind) === 0 && s.auth.signature === "0x", `kind=${s.auth.kind}`);
    const sim = await simulate(DEPLOYER, tx, { [tUSD]: { stateDiff: { [slotAllowance(DEPLOYER, EXPECTED_EXECUTOR)]: word(10_000_000n) } } });
    checkSimulation("prepare", "APPROVAL swap (allowance overridden = exact gross)", sim, { feeToken: tUSD, fee: "25000", intentId: A.intentId, minOut: A.minBuyAmount, recipient: DEPLOYER });
  }

  const pN = await tool("mpgr_prepare_trade", { quoteId: qN.data?.quoteId });
  if (check("prepare", "prepare native ETH sell (no approval needed)", !pN.isError && pN.data?.steps?.length === 1, pN.isError ? errCode(pN) : `${pN.data?.steps?.length} steps`)) {
    const tx = pN.data.transactionRequest;
    const s = decodeSwap(tx.data);
    check("prepare", "native: tx.to executor, value == 1e14 wei, tokenIn WETH", tx.to === EXPECTED_EXECUTOR && tx.value === "100000000000000" && same(s.p.tokenIn, WETH) && same(s.p.tokenOut, tUSD), JSON.stringify({ to: tx.to, value: tx.value, tokenIn: s.p.tokenIn }));
    const sim = await simulate(DEPLOYER, tx, { [DEPLOYER]: { balance: toHex(10n ** 18n) } });
    checkSimulation("prepare", "native ETH swap", sim, { feeToken: "ETH", fee: "250000000000", intentId: qN.data.intentId, minOut: qN.data.minBuyAmount, recipient: DEPLOYER, native: true });
  }

  const pE = await tool("mpgr_prepare_trade", { quoteId: A.quoteId, authorization: "EIP2612" });
  if (check("prepare", "prepare EIP2612", !pE.isError, pE.isError ? errCode(pE) : "")) {
    const td = pE.data.typedData;
    const dom = await client.readContract({ address: tUSD, abi: ERC20_ABI, functionName: "eip712Domain" });
    const nonce = await client.readContract({ address: tUSD, abi: ERC20_ABI, functionName: "nonces", args: [DEPLOYER] });
    check("prepare", "EIP2612 typed data: tUSD domain, owner=taker, spender=executor, value=gross, live nonce", td?.primaryType === "Permit" && td.domain.name === dom[1] && td.domain.version === dom[2] && td.domain.chainId === 84532 && same(td.domain.verifyingContract, tUSD) && same(td.message.owner, DEPLOYER) && same(td.message.spender, EXPECTED_EXECUTOR) && String(td.message.value) === "10000000" && String(td.message.nonce) === String(nonce), JSON.stringify(td?.message));
    check("prepare", "EIP2612: no tx until the user signs (transactionRequest null)", pE.data.transactionRequest === null, "");
    check("nosign", "EIP2612: finalize step carries a placeholder, not a signature", pE.data.steps.some((s) => s.tool === "mpgr_finalize_trade" && s.args?.signature === "<user signature>"), "");
  }
  const pP = await tool("mpgr_prepare_trade", { quoteId: A.quoteId, authorization: "PERMIT2" });
  if (check("prepare", "prepare PERMIT2", !pP.isError, pP.isError ? errCode(pP) : "")) {
    const td = pP.data.typedData;
    check("prepare", "PERMIT2 typed data: Permit2 domain, token tUSD, amount gross, spender executor", td?.primaryType === "PermitTransferFrom" && same(td.domain.verifyingContract, PERMIT2) && td.domain.chainId === 84532 && same(td.message.permitted.token, tUSD) && String(td.message.permitted.amount) === "10000000" && same(td.message.spender, EXPECTED_EXECUTOR), JSON.stringify(td?.message));
    const p2Allow = await client.readContract({ address: tUSD, abi: ERC20_ABI, functionName: "allowance", args: [DEPLOYER, PERMIT2] });
    const ap = pP.data.steps.find((s) => s.step === "sendApprovalTransaction");
    if (ap) {
      const d = decodeFunctionData({ abi: ERC20_ABI, data: ap.transactionRequest.data });
      check("prepare", "PERMIT2 approval targets Permit2 with the exact amount", same(d.args[0], PERMIT2) && d.args[1] === 10_000_000n, `${d.args}`);
    } else check("prepare", "PERMIT2 approval omitted only when Permit2 allowance >= gross", p2Allow >= 10_000_000n, `allowance=${p2Allow}`);
  }

  // ---------------------------------------------------------------- 7. finalize with a throwaway client-side wallet
  const userKey = generatePrivateKey();
  const user = privateKeyToAccount(userKey);
  const other = privateKeyToAccount(generatePrivateKey());
  info("flow", "throwaway client-side test wallet (unfunded, key never sent)", user.address);
  const pU = await tool("mpgr_prepare_trade", { quoteId: (await tool("mpgr_get_quote", { taker: user.address, sellToken: "tUSD", buyToken: "tSTOCK", sellAmountHuman: "5" })).data?.quoteId, authorization: "APPROVAL" });
  check("prepare", "prepare refuses an unfunded taker (INSUFFICIENT_BALANCE)", pU.isError && errCode(pU) === "INSUFFICIENT_BALANCE", errCode(pU));

  const qU = await tool("mpgr_get_quote", { taker: user.address, sellToken: "tUSD", buyToken: "tSTOCK", sellAmountHuman: "5" });
  if (check("flow", "quote for test wallet (5 tUSD)", !qU.isError && qU.data?.balanceSufficient === false, qU.isError ? errCode(qU) : `balanceSufficient=${qU.data?.balanceSufficient}`)) {
    const U = qU.data;
    const gross = BigInt(U.sellAmount);
    // EIP-2612: typed data built client-side from live token state, signed by the user's (test) wallet.
    const dom = await client.readContract({ address: tUSD, abi: ERC20_ABI, functionName: "eip712Domain" });
    const n = await client.readContract({ address: tUSD, abi: ERC20_ABI, functionName: "nonces", args: [user.address] });
    const permitTd = {
      domain: { name: dom[1], version: dom[2], chainId: 84532, verifyingContract: tUSD },
      types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Permit",
      message: { owner: user.address, spender: EXPECTED_EXECUTOR, value: gross, nonce: n, deadline: BigInt(U.deadline) },
    };
    const sig = await user.signTypedData(permitTd);
    const f1 = await tool("mpgr_finalize_trade", { quoteId: U.quoteId, authorization: "EIP2612", signature: sig, permitNonce: n.toString() });
    if (check("flow", "finalize EIP2612 with the taker's signature", !f1.isError, f1.isError ? errCode(f1) : "")) {
      const tx = f1.data.transactionRequest;
      const s = decodeSwap(tx.data);
      const ps = parseSignature(sig);
      check("flow", "finalize tx: to executor, value 0, recipient = taker, intentId matches", tx.to === EXPECTED_EXECUTOR && tx.value === "0" && txKeysOk(tx) && same(s.p.recipient, user.address) && s.p.intentId === intentIdOf(U.quoteId), JSON.stringify({ to: tx.to, recipient: s.p.recipient }));
      check("flow", "finalize auth = EIP2612 with the user's v/r/s, nonce, deadline", Number(s.auth.kind) === 1 && s.auth.r === ps.r && s.auth.s === ps.s && s.auth.nonce === n && s.auth.deadline === BigInt(U.deadline), `kind=${s.auth.kind}`);
      check("fee", "finalize calldata expectedFeeAmount == floor(5e6*25/1e4) = 12500", s.p.expectedFeeAmount === 12_500n && U.feeAmount === "12500", String(s.p.expectedFeeAmount));
      const sim = await simulate(user.address, tx, { [tUSD]: { stateDiff: { [slotBalance(user.address)]: word(gross) } } });
      checkSimulation("flow", "EIP2612 one-tx permit+fee+swap (balance overridden)", sim, { feeToken: tUSD, fee: U.feeAmount, intentId: U.intentId, minOut: U.minBuyAmount, recipient: user.address });
    }
    const bad = await tool("mpgr_finalize_trade", { quoteId: U.quoteId, authorization: "EIP2612", signature: await other.signTypedData(permitTd), permitNonce: n.toString() });
    check("flow", "finalize rejects a signature from a different wallet", bad.isError && errCode(bad) === "SIGNATURE_MISMATCH", errCode(bad));
    const stale = await tool("mpgr_finalize_trade", { quoteId: U.quoteId, authorization: "EIP2612", signature: sig, permitNonce: (n + 1n).toString() });
    check("flow", "finalize rejects a stale permit nonce", stale.isError && errCode(stale) === "PERMIT_NONCE_STALE", errCode(stale));
    const tampered = U.quoteId.slice(0, -2) + (U.quoteId.endsWith("AA") ? "BB" : "AA");
    const tq = await tool("mpgr_finalize_trade", { quoteId: tampered, authorization: "EIP2612", signature: sig, permitNonce: n.toString() });
    check("flow", "finalize rejects a tampered quoteId", tq.isError, errCode(tq));

    // Permit2 SignatureTransfer, same throwaway wallet.
    const p2Nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const p2Td = {
      domain: { name: "Permit2", chainId: 84532, verifyingContract: PERMIT2 },
      types: { PermitTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }], TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
      primaryType: "PermitTransferFrom",
      message: { permitted: { token: tUSD, amount: gross }, spender: EXPECTED_EXECUTOR, nonce: p2Nonce, deadline: BigInt(U.deadline) },
    };
    const sig2 = await user.signTypedData(p2Td);
    const f2 = await tool("mpgr_finalize_trade", { quoteId: U.quoteId, authorization: "PERMIT2", signature: sig2, permitNonce: p2Nonce.toString() });
    if (check("flow", "finalize PERMIT2 with the taker's signature", !f2.isError, f2.isError ? errCode(f2) : "")) {
      const tx = f2.data.transactionRequest;
      const s = decodeSwap(tx.data);
      check("flow", "finalize PERMIT2 auth: kind 2, user's signature bytes, nonce, deadline", Number(s.auth.kind) === 2 && lc(s.auth.signature) === lc(sig2) && s.auth.nonce === p2Nonce && tx.to === EXPECTED_EXECUTOR, `kind=${s.auth.kind}`);
      const sim = await simulate(user.address, tx, { [tUSD]: { stateDiff: { [slotBalance(user.address)]: word(gross), [slotAllowance(user.address, PERMIT2)]: word(gross) } } });
      checkSimulation("flow", "PERMIT2 one-tx transfer+fee+swap (balance/Permit2 allowance overridden)", sim, { feeToken: tUSD, fee: U.feeAmount, intentId: U.intentId, minOut: U.minBuyAmount, recipient: user.address });
    }
  }

  // ---------------------------------------------------------------- 7. status / verify
  const r0 = await client.getTransactionReceipt({ hash: REC.swaps[0].txHash });
  const st = await tool("mpgr_get_trade_status", { txHash: REC.swaps[0].txHash });
  check("flow", "get_trade_status(recorded swap) == confirmed @ correct block", !st.isError && st.data?.status === "confirmed" && st.data?.blockNumber === r0.blockNumber.toString() && st.data?.chainId === 84532, JSON.stringify(st.data));
  const unknownHash = keccak256(stringToHex(`mpgr-e2e-unknown-${Date.now()}`));
  const st2 = await tool("mpgr_get_trade_status", { txHash: unknownHash });
  check("flow", "get_trade_status(unknown hash) == pending_or_unknown", st2.data?.status === "pending_or_unknown", st2.data?.status);

  const qV = await tool("mpgr_get_quote", { taker: DEPLOYER, sellToken: "tUSD", buyToken: "tSTOCK", sellAmount: REC.swaps[0].grossAmountIn });
  if (check("flow", "quote matching recorded swap #1 params (100 tUSD)", !qV.isError, errCode(qV))) {
    const v = await tool("mpgr_verify_trade", { quoteId: qV.data.quoteId, txHash: REC.swaps[0].txHash });
    const checks = v.data?.checks ?? [];
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.ok]));
    check("flow", "verify_trade decodes the live receipt (status/from/to checks pass)", !v.isError && byName["receipt.status"] === true && byName["tx.to == executor"] === true && byName["tx.from == taker"] === true, JSON.stringify(byName));
    check("flow", "verify_trade REFUSES a trade not executed from this quote (intentId mismatch)", v.data?.verified === false && byName["exactly one SwapExecuted for intentId"] === false, `verified=${v.data?.verified}`);
    info("flow", "positive verify_trade needs a trade actually sent from a Preview quote by a real wallet", "not possible without signing/broadcasting; see report");
  }
  const vNF = await tool("mpgr_verify_trade", { quoteId: A.quoteId, txHash: unknownHash });
  check("flow", "verify_trade(unknown tx) -> TX_NOT_FOUND", vNF.isError && errCode(vNF) === "TX_NOT_FOUND", errCode(vNF));
  const vT = await tool("mpgr_verify_trade", { quoteId: A.quoteId.slice(0, -3) + "xyz", txHash: REC.swaps[0].txHash });
  check("flow", "verify_trade rejects a forged quoteId", vT.isError, errCode(vT));

  // ---------------------------------------------------------------- 9. mainnet (deployed; trading still off)
  const mq = await tool("mpgr_get_quote", { chainId: 8453, taker: DEPLOYER, sellToken: BASE_MAINNET_WETH, buyToken: BASE_MAINNET_USDC, sellAmount: "1000000000000000" });
  check("mainnet", "get_quote chainId 8453 -> BASE_MAINNET_DISABLED (flag off)", mq.isError && errCode(mq) === "BASE_MAINNET_DISABLED", errCode(mq));
  const ml = await tool("mpgr_list_tokens", { chainId: 8453 });
  check("mainnet", "list_tokens chainId 8453 -> deployed tokens USDC,WETH", !ml.isError && (ml.data?.tokens ?? []).map((t) => t.symbol).join(",") === "USDC,WETH" && ml.data?.tradingEnabled === false, ml.isError ? errCode(ml) : `${(ml.data?.tokens ?? []).map((t) => t.symbol).join(",")} tradingEnabled=${ml.data?.tradingEnabled}`);
  const bad1 = await tool("mpgr_get_quote", { chainId: 1, taker: DEPLOYER, sellToken: "ETH", buyToken: "tUSD", sellAmount: "1" });
  check("mainnet", "unsupported chain (1) rejected", bad1.isError, errCode(bad1));
  const llm = await fetch(url("/llm.txt"), { headers: headers() });
  const llmText = await llm.text();
  check("executor", "/llm.txt advertises the Sepolia executor", llm.status === 200 && llmText.includes(`MPGR Executor: ${EXPECTED_EXECUTOR}`), `HTTP ${llm.status}`);
  check("mainnet", "/llm.txt advertises the deployed Base mainnet executor", llm.status === 200 && llmText.includes(`MPGR Executor: ${EXPECTED_MAINNET_EXECUTOR}`) && llmText.includes("aerodrome-slipstream tickSpacing 50"), `HTTP ${llm.status}`);

  // ---------------------------------------------------------------- 6. nothing signed / broadcast server-side
  const nonceAfter = { latest: await client.getTransactionCount({ address: DEPLOYER }), pending: await client.getTransactionCount({ address: DEPLOYER, blockTag: "pending" }) };
  check("nosign", "taker nonce unchanged (latest+pending): nothing was broadcast", nonceAfter.latest === nonceBefore.latest && nonceAfter.pending === nonceBefore.pending, `${JSON.stringify(nonceBefore)} -> ${JSON.stringify(nonceAfter)}`);
  check("nosign", "test wallet nonce still 0", (await client.getTransactionCount({ address: user.address, blockTag: "pending" })) === 0, "");
  const all = rawResponses.join("\n");
  check("nosign", "no key material / signed tx fields in any response", !/"(private_?key|mnemonic|seed_?phrase|raw_?transaction|signed_?transaction|serialized_?transaction)"\s*:/i.test(all), "");
  check("nosign", "no 65-byte signature produced by the server in any response", !/"signature"\s*:\s*"0x[0-9a-fA-F]{130}"/.test(all), "");
  check("nosign", "the test wallet key never appears in any response", !all.toLowerCase().includes(userKey.slice(2).toLowerCase()), "");
}

try {
  await main();
} catch (e) {
  check("endpoint", "E2E run completed without an exception", false, String(e?.stack ?? e).slice(0, 600));
}

// ------------------------------------------------------------------ report
const failed = results.filter((r) => !r.ok);
const byGroup = Object.entries(GROUPS).map(([k, title]) => {
  const rs = results.filter((r) => r.group === k);
  return { key: k, title, pass: rs.filter((r) => r.ok && r.level === "check").length, fail: rs.filter((r) => !r.ok).length, info: rs.filter((r) => r.level === "info").length, rs };
});
writeFileSync(OUT_JSON, JSON.stringify({ previewUrl: PREVIEW_URL, executor: EXPECTED_EXECUTOR, at: new Date().toISOString(), results }, null, 2));
const md = [
  `<!-- mpgr-e2e-preview -->`,
  `### MCP Preview E2E: Base Sepolia (${failed.length === 0 ? "all checks passed" : `${failed.length} FAILED`})`,
  ``,
  `Endpoint: \`${PREVIEW_URL}/api/mcp\`. Executor \`${EXPECTED_EXECUTOR}\`. Run at ${new Date().toISOString()}. Read-only: nothing signed server-side, nothing broadcast.`,
  ``,
  `| # | area | pass | fail | info |`,
  `|---|---|---|---|---|`,
  ...byGroup.map((g) => `| ${g.title.split(".")[0]} | ${g.title.split(". ")[1]} | ${g.pass} | ${g.fail} | ${g.info} |`),
  ``,
  ...byGroup.flatMap((g) => [
    `<details><summary>${g.title}: ${g.fail ? `❌ ${g.fail} failed` : "✅"}</summary>`,
    ``,
    ...g.rs.map((r) => `- ${r.ok ? (r.level === "info" ? "ℹ️" : "✅") : "❌"} ${r.name}${r.detail ? `: \`${r.detail.slice(0, 300).replace(/`/g, "'")}\`` : ""}`),
    ``,
    `</details>`,
  ]),
].join("\n");
writeFileSync(OUT_MD, md);
console.log(`\n${results.filter((r) => r.ok && r.level === "check").length} passed, ${failed.length} failed, ${results.filter((r) => r.level === "info").length} info`);
process.exit(failed.length === 0 ? 0 : 1);
