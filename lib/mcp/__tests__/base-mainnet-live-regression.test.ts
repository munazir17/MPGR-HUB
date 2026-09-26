import { decodeFunctionData, maxUint256, parseAbi, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, MPGR_EXECUTOR_DEPLOYMENTS, findExecutorRoute } from "@/lib/executor/executor-config";
import { computeExecutorFee } from "@/lib/executor/executor-fee";
import { approvalAuthorization, buildExecutorIntent, encodeExecutorSwap, type UnsignedTransactionRequest } from "@/lib/executor/executor-intent";
import { verifyExecutorReceipt } from "@/lib/executor/executor-verify";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { computeUniswapV3PoolAddress } from "@/lib/executor/uniswap-v3-pool";
import { handleMcpMessage } from "@/lib/mcp/mcp-server";
import { getQuote, prepareTrade, type McpDeps, type ToolOutcome } from "@/lib/mcp/mcp-trade-service";
import { ZERO_EX_ALLOWANCE_HOLDER_BASE } from "@/lib/trade/zero-ex-native-fee";

import { LIVE_PINS as P, LIVE_TRADES, historicalReceipt, type LiveTradeFixture } from "./base-mainnet-live-fixtures";
import { fakeReader, newFakeState, setAllowance, setBalance, testDeps } from "./fixtures";

function ok(outcome: ToolOutcome) {
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  return outcome.data;
}

async function tool(deps: McpDeps, name: string, args: Record<string, unknown>) {
  const response = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, deps);
  expect(response).not.toHaveProperty("error");
  const result = response?.result as { isError: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] };
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  return result.structuredContent;
}

function setup(f: LiveTradeFixture) {
  const state = newFakeState();
  state.feeRecipient = P.feeRecipient;
  setBalance(state, f.sellToken, P.taker, f.gross);
  state.receipts.set(f.hash, historicalReceipt(f));
  const reader = fakeReader(state, 8453, P.executor);
  const readContract = vi.spyOn(reader, "readContract");
  // Deterministic stand-in for a NEW quote, using recorded realized output.
  // This is NOT the original pre-trade quote (nor a claim about today's price).
  const simulate = vi.spyOn(reader, "simulateContract").mockResolvedValue({ result: [f.amountOut, 0n, 0, 0n] });
  const receipt = vi.spyOn(reader, "getTransactionReceipt");
  const readerForChain = vi.fn((chainId: number) => {
    expect(chainId).toBe(8453);
    return reader;
  });
  const zeroExFetch = vi.fn<typeof fetch>(() => { throw new Error("Unexpected 0x fallback for proven pair"); });
  const deps = testDeps(state, {
    registry: MPGR_EXECUTOR_DEPLOYMENTS, // Real registry, NOT the generic fake mainnet deployment.
    reader: readerForChain,
    mainnetEnabled: true,
    mainnetFeeRecipient: null, // executor reads its fee recipient on chain, independent of 0x
    zeroExFetch,
  });
  const args = { chainId: 8453, taker: P.taker, sellToken: f.sellToken, buyToken: f.buyToken, sellAmount: String(f.gross), slippageBps: 100 };
  return { state, deps, args, simulate, readContract, receipt, readerForChain, zeroExFetch };
}

function decodeSwap(data: Hex) {
  const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data });
  if (decoded.functionName !== "swapUniswapV3ExactInputSingle") throw new Error("Wrong swap entrypoint");
  return decoded.args;
}

function historicalIntent(f: LiveTradeFixture) {
  const [params] = decodeSwap(f.input);
  const built = buildExecutorIntent({
    deployment: BASE_MAINNET_EXECUTOR_DEPLOYMENT,
    taker: P.taker,
    sellToken: f.sellToken,
    buyToken: f.buyToken,
    sellAmount: f.gross,
    expectedBuyAmount: f.amountOut,
    slippageBps: 100,
    authorization: "APPROVAL",
    nowSeconds: f.timestamp,
    quoteId: "historical-replay-not-an-original-quote-id",
    feeBps: 25,
    feeRecipient: P.feeRecipient,
  });
  if (!built.ok) throw new Error(built.error.message);
  // The historical HMAC quoteId is unavailable. Recover ONLY the on-chain
  // intent id, deadline and minimum output from captured calldata for replay.
  return { ...built.value, intentId: params.intentId, deadline: Number(params.deadline), minBuyAmount: String(params.amountOutMinimum) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(LIVE_TRADES)("Base Mainnet historical regression: $direction ($hash)", (f) => {
  it("pins the production registry and the CREATE2-derived pool independently of implementation constants", () => {
    const d = BASE_MAINNET_EXECUTOR_DEPLOYMENT;
    expect(d).toMatchObject({ chainId: 8453, executor: P.executor, feeRecipient: P.feeRecipient, feeBps: 25, weth: P.weth });
    expect(d.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: P.usdc, decimals: 6 }),
      expect.objectContaining({ address: P.weth, decimals: 18 }),
    ]));
    const route = findExecutorRoute(d, f.sellToken, f.buyToken);
    expect(route).toMatchObject({ kind: 2, router: P.router, quoter: P.quoter, poolFee: 3000 });
    expect(route?.tickSpacing).toBeUndefined();
    expect(computeUniswapV3PoolAddress(P.factory, f.sellToken, f.buyToken, 3000)).toBe(P.pool);
  });

  it("matches the mined calldata byte-for-byte and verifies the captured raw executor log", () => {
    const intent = historicalIntent(f);
    expect(encodeExecutorSwap(intent, approvalAuthorization())).toEqual({ chainId: 8453, to: P.executor, value: "0", data: f.input });
    const [params, poolFee, auth] = decodeSwap(f.input);
    expect(params).toMatchObject({ router: P.router, tokenIn: f.sellToken, tokenOut: f.buyToken, grossAmountIn: f.gross, expectedFeeAmount: f.fee, recipient: P.taker, unwrapNativeOut: false, intentId: f.intentId });
    expect(poolFee).toBe(3000);
    expect(auth).toEqual(approvalAuthorization());
    expect(verifyExecutorReceipt(historicalReceipt(f), intent)).toMatchObject({
      verified: true,
      transactionHash: f.hash,
      blockNumber: String(f.blockNumber),
      event: { taker: P.taker, router: P.router, tokenIn: f.sellToken, tokenOut: f.buyToken, grossAmountIn: String(f.gross), feeAmount: String(f.fee), swapAmountIn: String(f.net), amountOut: String(f.amountOut), feeRecipient: P.feeRecipient, feeBps: 25, routerKind: 2, flags: 0 },
    });
    expect(computeExecutorFee(f.gross, 25)).toEqual({ ok: true, value: { grossAmountIn: f.gross, feeBps: 25, feeAmount: f.fee, swapAmountIn: f.net } });
  });

  it("quotes -> prepares via MCP with exact gross approval, net quoter input and no server wallet effects", async () => {
    const s = setup(f);
    const network = vi.fn(() => { throw new Error("No external requests permitted in this offline flow"); });
    vi.stubGlobal("fetch", network);
    const q = await tool(s.deps, "mpgr_get_quote", s.args);
    expect(q).toMatchObject({
      chainId: 8453, provider: "mpgr-executor", executor: P.executor, spender: P.executor,
      taker: P.taker, recipient: P.taker, feeRecipient: P.feeRecipient, feeBps: 25,
      feeToken: f.sellToken, sellAmount: String(f.gross), feeAmount: String(f.fee), swapAmount: String(f.net),
      expectedBuyAmount: String(f.amountOut), minBuyAmount: String(f.amountOut * 9900n / 10000n),
      sellNative: false, buyNative: false,
      route: { venue: "uniswap-v3", router: P.router, poolFee: 3000, executor: P.executor, hops: 1 },
    });
    expect(s.simulate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: P.quoter, functionName: "quoteExactInputSingle",
      args: [{ tokenIn: f.sellToken, tokenOut: f.buyToken, amountIn: f.net, fee: 3000, sqrtPriceLimitX96: 0n }],
    }));
    // Agent-supplied overrides must never alter the HMAC-bound quote.
    const prepared = await tool(s.deps, "mpgr_prepare_trade", {
      quoteId: q.quoteId, authorization: "APPROVAL", chainId: 1,
      taker: P.feeRecipient, recipient: P.feeRecipient, sellAmount: "1", feeBps: 0, router: P.feeRecipient,
    });
    const intent = prepared.intent as Record<string, unknown>;
    for (const key of Object.keys(intent)) expect(intent[key], `quote/prepare ${key}`).toEqual(q[key]);
    const steps = prepared.steps as { step: string; who: string; transactionRequest: UnsignedTransactionRequest; afterPreviousStepConfirmed?: boolean }[];
    expect(steps.map(({ step, who }) => ({ step, who }))).toEqual([
      { step: "sendApprovalTransaction", who: "user wallet" },
      { step: "sendSwapTransaction", who: "user wallet" },
    ]);
    expect(steps[0].transactionRequest).toMatchObject({ chainId: 8453, to: f.sellToken, value: "0" });
    const approval = decodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount)"]), data: steps[0].transactionRequest.data });
    expect(approval.args).toEqual([P.executor, f.gross]);
    expect(approval.args?.[1]).not.toBe(maxUint256);
    const tx = prepared.transactionRequest as UnsignedTransactionRequest;
    expect(tx).toEqual(steps[1].transactionRequest);
    expect(Object.keys(tx).sort()).toEqual(["chainId", "data", "to", "value"]); // unsigned; no raw tx/signature
    expect(tx).toMatchObject({ chainId: 8453, to: P.executor, value: "0" });
    expect(steps[1].afterPreviousStepConfirmed).toBe(true);
    const [params, poolFee, auth] = decodeSwap(tx.data);
    expect(params).toEqual({ router: P.router, tokenIn: f.sellToken, tokenOut: f.buyToken, grossAmountIn: f.gross, expectedFeeAmount: f.fee, amountOutMinimum: BigInt(String(q.minBuyAmount)), recipient: P.taker, deadline: BigInt(String(q.deadline)), intentId: q.intentId, unwrapNativeOut: false });
    expect(poolFee).toBe(3000);
    expect(auth).toEqual(approvalAuthorization());
    expect(prepared.typedData).toBeNull();
    expect(prepared.permit).toBeNull();
    expect(s.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: f.sellToken, functionName: "allowance", args: [P.taker, P.executor] }));
    for (const functionName of ["feeBps", "feeRecipient", "paused", "MAX_FEE_BPS", "owner"]) {
      expect(s.readContract.mock.calls.filter(([a]) => a.address === P.executor && a.functionName === functionName)).toHaveLength(2);
    }
    expect(s.simulate).toHaveBeenCalledTimes(1); // prepare does not silently reprice
    expect(s.zeroExFetch).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["net-only", "gross-minus-one", "exact-gross"])("checks gross (not net) allowance: %s", async (allowanceCase) => {
    const s = setup(f);
    const allowance = allowanceCase === "net-only" ? f.net : allowanceCase === "gross-minus-one" ? f.gross - 1n : f.gross;
    setAllowance(s.state, f.sellToken, P.taker, P.executor, allowance);
    const q = ok(await getQuote(s.deps, s.args));
    const p = ok(await prepareTrade(s.deps, { quoteId: q.quoteId, authorization: "APPROVAL" }));
    const steps = p.steps as { step: string }[];
    expect(steps.map((s) => s.step)).toEqual(allowance === f.gross ? ["sendSwapTransaction"] : ["sendApprovalTransaction", "sendSwapTransaction"]);
  });

  it.each(["fee", "recipient"])("refuses changed live %s between quote and prepare", async (field) => {
    const s = setup(f);
    const q = ok(await getQuote(s.deps, s.args));
    if (field === "fee") s.state.feeBps = 26;
    else s.state.feeRecipient = P.taker;
    expect(await prepareTrade(s.deps, { quoteId: q.quoteId })).toMatchObject({ ok: false, error: { code: "QUOTE_STALE" } });
  });

  it("detects the recorded confirmed receipt, and distinguishes reverted and unknown status", async () => {
    const s = setup(f);
    const args = { chainId: 8453, txHash: f.hash };
    expect(await tool(s.deps, "mpgr_get_trade_status", args)).toEqual({ ...args, status: "confirmed", blockNumber: String(f.blockNumber), explorerUrl: `https://basescan.org/tx/${f.hash}` });
    expect(s.receipt).toHaveBeenCalledExactlyOnceWith({ hash: f.hash });
    s.state.receipts.set(f.hash, { ...historicalReceipt(f), status: "reverted" });
    expect(await tool(s.deps, "mpgr_get_trade_status", args)).toMatchObject({ status: "reverted" });
    s.state.receipts.clear();
    expect(await tool(s.deps, "mpgr_get_trade_status", args)).toMatchObject({ status: "pending_or_unknown" });
  });

  it.each(["taker", "feeRecipient", "feeAmount", "sellAmount", "router", "minBuyAmount"])("rejects historical receipt versus incorrect intent %s", (field) => {
    const intent = historicalIntent(f);
    const wrong = { ...intent };
    if (field === "taker" || field === "feeRecipient" || field === "router") wrong[field] = P.usdc;
    else if (field === "feeAmount") wrong.feeAmount = String(f.fee + 1n);
    else if (field === "sellAmount") wrong.sellAmount = String(f.gross + 1n);
    else wrong.minBuyAmount = String(f.amountOut + 1n);
    expect(verifyExecutorReceipt(historicalReceipt(f), wrong).verified).toBe(false);
  });

  it("rejects a one-unit error in the event's after-fee swap amount", () => {
    const receipt = historicalReceipt(f);
    const words = f.eventData.slice(2).match(/.{64}/g)!;
    words[4] = (f.net + 1n).toString(16).padStart(64, "0");
    const logs = receipt.logs.map((log) => ({ ...log, data: `0x${words.join("")}` as Hex }));
    const result = verifyExecutorReceipt({ ...receipt, logs }, historicalIntent(f));
    expect(result.verified).toBe(false);
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["feeAmount + swapAmountIn == gross"]);
  });

  it("rejects spoofed, missing or duplicate executor events", () => {
    const receipt = historicalReceipt(f);
    const intent = historicalIntent(f);
    for (const logs of [[], [...receipt.logs, ...receipt.logs], receipt.logs.map((l) => ({ ...l, address: P.router }))]) {
      expect(verifyExecutorReceipt({ ...receipt, logs }, intent).verified).toBe(false);
    }
  });
});

it.each([
  [399n, null, null], [400n, 1n, 399n], [401n, 1n, 400n],
  [1_000_001n, 2_500n, 997_501n],
  [100_000_000_000_399n, 250_000_000_000n, 99_750_000_000_399n],
])("25 bps integer floor boundaries: gross=%s", (gross, fee, net) => {
  const result = computeExecutorFee(gross, 25);
  if (fee === null) expect(result).toMatchObject({ ok: false, error: { code: "FEE_ROUNDS_TO_ZERO" } });
  else expect(result).toEqual({ ok: true, value: { grossAmountIn: gross, feeBps: 25, feeAmount: fee, swapAmountIn: net } });
});

it.each([
  ["arbitrary ERC-20", "0x0000000000000000000000000000000000004321"],
  ["B20 stock", "0xb200000000000000000000C2e324d24d7eEcd1fb"],
])("preserves the 0x fallback for %s with the REAL production registry", async (_, buyToken) => {
  vi.stubEnv("ZERO_EX_API_KEY", "offline-test-placeholder");
  const s = setup(LIVE_TRADES[0]);
  const zeroExFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    liquidityAvailable: true,
    sellToken: P.usdc, buyToken, sellAmount: "1000000", buyAmount: "2000000", minBuyAmount: "1980000",
    fees: { integratorFee: { amount: "2500", token: P.usdc } },
    issues: { allowance: { spender: ZERO_EX_ALLOWANCE_HOLDER_BASE } },
    transaction: { to: ZERO_EX_ALLOWANCE_HOLDER_BASE, data: "0xabcdef", value: "0" },
  }), { status: 200 }));
  const deps = { ...s.deps, mainnetFeeRecipient: P.feeRecipient, zeroExFetch };
  const q = ok(await getQuote(deps, { ...s.args, buyToken }));
  expect(q).toMatchObject({ provider: "0x-native-fee", feeBps: 25, feeAmount: "2500", feeRecipient: P.feeRecipient, spender: ZERO_EX_ALLOWANCE_HOLDER_BASE });
  expect(q).not.toHaveProperty("executor");
  const p = ok(await prepareTrade(deps, { quoteId: q.quoteId, authorization: "APPROVAL" }));
  expect(p.transactionRequest).toMatchObject({ chainId: 8453, to: ZERO_EX_ALLOWANCE_HOLDER_BASE });
  const steps = p.steps as { transactionRequest: UnsignedTransactionRequest }[];
  expect(decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: steps[0].transactionRequest.data }).args).toEqual([ZERO_EX_ALLOWANCE_HOLDER_BASE, 1_000_000n]);
  expect(zeroExFetch).toHaveBeenCalledTimes(2); // fallback still refreshes calldata on prepare
  expect(s.simulate).not.toHaveBeenCalled();
  expect(s.readContract.mock.calls.some(([args]) => args.address === P.executor)).toBe(false);
});
