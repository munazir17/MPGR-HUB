import { describe, it, expect } from "vitest";
import { swapQuoteExpiry, swapQuoteFresh, swapQuoteNeedsRefresh } from "../swap-lifecycle";
import { simulatedExecutorQuote } from "@/tests/mobile/flow-fixtures";
import { chatDraftToForm } from "@/components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
import { decodeFunctionData, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { TRADE_QUOTE_MAX_AGE_MS, BASE_USDC, BASE_WETH } from "@/lib/trade/trade-config";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { MPGR_SWAP_EXECUTOR_ABI } from "../swap-executor-abi";
import { SWAP_PATH_EXECUTOR_DEPLOYMENT, SWAP_PATH_VENUES } from "../swap-executor-config";
import { swapPathFeeFloor } from "../swap-executor-intent";
const prompt = "Buy AAPLc whenever price falls below $200 worth 1 USDC";
const quote = () => simulatedExecutorQuote(chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt)));
describe("Swap clocks preserve provider and route validity", () => {
 it("caps a generous response at the quote policy, without rewriting its timestamps",()=>{
  const p=quote(), created=Date.parse(p.quotedAt);p.expiresAt=new Date(created+600000).toISOString();const original=p.expiresAt;
  expect(swapQuoteExpiry(p)).toBe(created+TRADE_QUOTE_MAX_AGE_MS);expect(p.expiresAt).toBe(original);expect(swapQuoteFresh(p,created+TRADE_QUOTE_MAX_AGE_MS)).toBe(false);
 });
 it("honors a genuinely shorter expiry, including the exact expiry boundary",()=>{
  const p=quote(), created=Date.parse(p.quotedAt);p.expiresAt=new Date(created+1000).toISOString();
  expect(swapQuoteFresh(p,created+999)).toBe(true);expect(swapQuoteFresh(p,created+1000)).toBe(false);
  expect(swapQuoteNeedsRefresh(p,created+100)).toBe(false);expect(swapQuoteNeedsRefresh(p,created+800)).toBe(true);
 });
 it("requests review-time refresh near expiry, not on every render",()=>{const p=quote(),created=Date.parse(p.quotedAt);expect(swapQuoteNeedsRefresh(p,created+1000)).toBe(false);expect(swapQuoteNeedsRefresh(p,created+TRADE_QUOTE_MAX_AGE_MS-4000)).toBe(true);});
 it("enforces the actual encoded route deadline even if response metadata is later",()=>{
  const p=quote(),created=Date.parse(p.quotedAt);const x=decodeFunctionData({abi:MPGR_EXECUTOR_ABI,data:p.transaction!.data});
  if(x.functionName!=="swapSlipstreamExactInputSingle")throw new Error("Unexpected fixture route");
  const args=x.args;p.transaction!.data=encodeFunctionData({abi:MPGR_EXECUTOR_ABI,functionName:x.functionName,args:[{...args[0],deadline:BigInt(Math.floor(created/1000)+1)},args[1],args[2]]});
  expect(swapQuoteExpiry(p)).toBe((Math.floor(created/1000)+1)*1000);expect(swapQuoteFresh(p,created+2000)).toBe(false);
 });
 it("invalid dates, reversed clocks, future creation and malformed calldata fail closed",()=>{
  const p=quote();p.expiresAt="invalid";expect(swapQuoteFresh(p)).toBe(false);p.expiresAt=p.quotedAt;expect(swapQuoteFresh(p)).toBe(false);
  p.quotedAt=new Date(Date.now()+10000).toISOString();p.expiresAt=new Date(Date.now()+20000).toISOString();expect(swapQuoteFresh(p)).toBe(false);
  const good=quote();good.transaction!.data="0x";expect(swapQuoteFresh(good)).toBe(false);
 });
});

describe("Swap-path executor proposals use the swap-path deadline, not the legacy decoder", () => {
 const deployment = SWAP_PATH_EXECUTOR_DEPLOYMENT!;
 const taker = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address;
 const pool = "0xc3000000000000000000000000000000000000cc" as Address;
 const created = 1_700_000_000_000;
 const pathProposal = (deadline: bigint, fee = swapPathFeeFloor(1_000_000n)): TradeProposal => {
  const data = encodeFunctionData({ abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "swapExactInput", args: [{
   router: SWAP_PATH_VENUES.uniswapV2.router, tokenIn: BASE_USDC, tokenOut: BASE_WETH,
   grossAmountIn: 1_000_000n, expectedFeeAmount: fee, amountOutMinimum: 990n,
   recipient: taker, deadline, intentId: keccak256("0x01"), unwrapNativeOut: false,
  }, [{ router: SWAP_PATH_VENUES.uniswapV2.router, tokenOut: BASE_WETH, kind: 3, poolFee: 0, tickSpacing: 0, stable: false, pool }],
  { kind: 0, deadline: 0n, nonce: 0n, v: 0, r: ("0x" + "0".repeat(64)) as Hex, s: ("0x" + "0".repeat(64)) as Hex, signature: "0x" }] });
  return {
   provider: "mpgr-executor", taker,
   from: { address: BASE_USDC }, to: { address: BASE_WETH },
   quotedAt: new Date(created).toISOString(), expiresAt: new Date(created + 600_000).toISOString(),
   transaction: { to: deployment.executor, data, value: "0" },
  } as unknown as TradeProposal;
 };
 it("a valid path proposal is fresh inside its response window (regression: legacy decode zeroed its expiry)", () => {
  const p = pathProposal(9999999999n);
  expect(swapQuoteExpiry(p)).toBe(created + TRADE_QUOTE_MAX_AGE_MS);
  expect(swapQuoteFresh(p, created + 1_000)).toBe(true);
  expect(swapQuoteFresh(p, created + TRADE_QUOTE_MAX_AGE_MS)).toBe(false);
 });
 it("the encoded swap-path deadline caps freshness, and fee-tampered calldata fails closed", () => {
  const deadlineMs = created + 10_000;
  const p = pathProposal(BigInt(deadlineMs / 1000));
  expect(swapQuoteExpiry(p)).toBe(deadlineMs);
  expect(swapQuoteFresh(p, created + 1_000)).toBe(true);
  expect(swapQuoteFresh(p, deadlineMs)).toBe(false);
  expect(swapQuoteExpiry(pathProposal(9999999999n, swapPathFeeFloor(1_000_000n) - 1n))).toBe(0);
 });
});
