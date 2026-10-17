import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { parseSlippagePercent, safeMaximum, slippagePercent, swapQuotePolicyError, swapFeePolicyError, verifySwapSettlement } from "../swap-policy";
import { simulatedExecutorQuote } from "@/tests/mobile/flow-fixtures";
import { simulatedSwapReceipt } from "@/tests/mobile/swap-receipt-fixture";
import { LIVE_TRADES, LIVE_PINS, historicalReceipt } from "@/lib/mcp/__tests__/base-mainnet-live-fixtures";
import { MANUAL_SWAP_TOKENS } from "@/lib/trade/manual-swap";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { chatDraftToForm } from "@/components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
const prompt = "Buy AAPLc whenever price falls below $200 worth 1 USDC";
const form = chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt));
const quote = () => simulatedExecutorQuote(form);
const hash = `0x${"ab".repeat(32)}` as const;
describe("Swap integer policy", () => {
  it.each([["0.01", 1], ["0.1", 10], ["0.5", 50], ["1", 100], ["5.00", 500]])("parses %s percent exactly", (s, bps) => { expect(parseSlippagePercent(s)).toBe(bps); expect(parseSlippagePercent(slippagePercent(bps))).toBe(bps); });
  it.each(["0", "-1", "5.01", "1.001", "1e2", "Infinity", "", "0.009", "NaN"])("refuses invalid percent %s", s => expect(parseSlippagePercent(s)).toBeNull());
  it("MAX reserves a buffered real native estimate, never invents one", () => { expect(safeMaximum(1000n, true, 30n)).toBe(940n); expect(safeMaximum(50n, true, 30n)).toBe(0n); expect(safeMaximum(1000n, true, null)).toBeNull(); expect(safeMaximum(1000n, false, null)).toBe(1000n); });
  it.each([10, 50, 100, 500])("quoted and encoded minimum agree at %sbps", slippageBps => { const p = simulatedExecutorQuote({ ...form, slippageBps }); expect(BigInt(p.minToAmount)).toBe(BigInt(p.toAmount) * BigInt(10000 - slippageBps) / 10000n); expect(swapFeePolicyError(p)).toBeNull(); });
  it.each(["cdp-trade-api", "0x-swap-api", "aerodrome-slipstream"] as const)("blocks fee-skipping %s on Swap", provider => { const p = quote(); p.provider = provider; expect(swapFeePolicyError(p)).toMatch(/cannot safely collect/); });
  it.each(["fee", "bps", "recipient", "minimum", "direction", "spender", "value"])("blocks manipulated %s", kind => {
    const p = quote();
    if (kind === "fee") p.agentFee!.amountAtomic = "1";
    if (kind === "bps") p.agentFee!.bps = 50;
    if (kind === "recipient") p.agentFee!.recipient = p.taker;
    if (kind === "minimum") p.minToAmount = "1";
    if (kind === "direction") [p.from, p.to] = [p.to, p.from];
    if (kind === "spender") p.permit2Spender = p.taker;
    if (kind === "value") p.transaction!.value = "1";
    expect(swapFeePolicyError(p)).toBeTruthy();
  });
});
describe("receipt is execution and fee evidence, not UI display", () => {
  it("requires exact Executor event before output / collection claims", () => {
    const p = quote(); const receipt = simulatedSwapReceipt(p, hash);
    expect(verifySwapSettlement(p, receipt)).toMatchObject({ verified: true, amountOut: p.toAmount, feeAmount: p.agentFee!.amountAtomic, feeRecipient: p.agentFee!.recipient });
    expect(verifySwapSettlement(p, { ...receipt, logs: [] })).toMatchObject({ verified: false, feeAmount: null, amountOut: null });
  });
  it.each(["recipient", "fee", "output", "emitter", "sender", "duplicate", "reverted"])("refuses %s mismatch", kind => {
    const p = quote(); const r = simulatedSwapReceipt(p, hash, kind === "recipient" ? { feeRecipient: p.taker } : kind === "fee" ? { feeAmount: 1n } : kind === "output" ? { amountOut: 1n } : {});
    if (kind === "emitter") r.logs = r.logs.map(l => ({ ...l, address: p.taker }));
    if (kind === "sender") r.from = p.agentFee!.recipient!;
    if (kind === "duplicate") r.logs = [...r.logs, ...r.logs];
    if (kind === "reverted") r.status = "reverted";
    expect(verifySwapSettlement(p, r)).toMatchObject({ verified: false, feeAmount: null });
  });
  it.each(LIVE_TRADES)("replays archived raw mainnet evidence for $direction, not a fresh RPC read", f => {
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: f.input });
    if (decoded.functionName !== "swapUniswapV3ExactInputSingle") throw new Error("Wrong historical method");
    const [params] = decoded.args;
    const p = quote();
    p.from = MANUAL_SWAP_TOKENS.find(t => t.address === f.sellToken)!; p.to = MANUAL_SWAP_TOKENS.find(t => t.address === f.buyToken)!;
    p.fromAmount = f.gross.toString(); p.toAmount = f.amountOut.toString(); p.minToAmount = params.amountOutMinimum.toString(); p.taker = LIVE_PINS.taker;
    p.agentFee = { status: "applied", bps: 25, amountAtomic: f.fee.toString(), displayAmount: null, recipient: LIVE_PINS.feeRecipient, collection: "mpgr-executor", reason: null };
    p.transaction = { to: LIVE_PINS.executor, data: f.input, value: "0" }; p.permit2Spender = LIVE_PINS.executor;
    expect(verifySwapSettlement(p, historicalReceipt(f))).toMatchObject({ verified: true, amountOut: f.amountOut.toString(), feeAmount: f.fee.toString(), feeRecipient: LIVE_PINS.feeRecipient });
  });
});

describe("fee asset is always the pay asset, including native direction", () => {
  it.each([["ETH", "USDC", "0.01", "25000000000000"], ["USDC", "ETH", "1", "2500"], ["AAPLc", "USDC", "1", "250000"]])("%s → %s exact atomic fee", (sell, buy, amount, fee) => {
    const pay = MANUAL_SWAP_TOKENS.find(t => t.symbol === sell)!, receive = MANUAL_SWAP_TOKENS.find(t => t.symbol === buy)!;
    const p = simulatedExecutorQuote({ ...form, sell: pay.address, buy: receive.address, sellAmount: amount });
    expect(p.agentFee!.amountAtomic).toBe(fee); expect(swapFeePolicyError(p)).toBeNull();
    expect(verifySwapSettlement(p, simulatedSwapReceipt(p, hash))).toMatchObject({ verified: true, feeAmount: fee });
  });
});

it("coordinated minimum mutation in proposal AND calldata cannot weaken selected slippage", () => {
  const p = quote();
  const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: p.transaction!.data });
  if (decoded.functionName !== "swapSlipstreamExactInputSingle") throw Error("Unexpected fixture route");
  p.minToAmount = "1";
  p.transaction!.data = encodeFunctionData({ abi: MPGR_EXECUTOR_ABI, functionName: decoded.functionName, args: [{ ...decoded.args[0], amountOutMinimum: 1n }, decoded.args[1], decoded.args[2]] });
  expect(swapFeePolicyError(p)).toBeNull(); // prior policy only matched displayed/encoded values
  expect(swapQuotePolicyError(p)).toMatch(/minimum receive/);
});
it.each([0, 501, 10000, 1.5, NaN])("quote admission rejects invalid slippage %s", slippageBps => { const p = quote(); p.slippageBps = slippageBps; expect(swapQuotePolicyError(p)).toBeTruthy(); });
it.each([1, 50, 100, 500])("quote minimum uses exact floor at %s bps", slippageBps => { const p = simulatedExecutorQuote({ ...form, slippageBps }, 100001n); expect(p.minToAmount).toBe((100001n * BigInt(10000 - slippageBps) / 10000n).toString()); expect(swapQuotePolicyError(p)).toBeNull(); });
