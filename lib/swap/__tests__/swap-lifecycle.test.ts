import { describe, it, expect } from "vitest";
import { swapQuoteExpiry, swapQuoteFresh, swapQuoteNeedsRefresh } from "../swap-lifecycle";
import { simulatedExecutorQuote } from "@/tests/mobile/flow-fixtures";
import { chatDraftToForm } from "@/components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
const prompt = "Buy AAPLc whenever price falls below $200 worth 1 USDC";
const quote = () => simulatedExecutorQuote(chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt)));
describe("Swap clocks preserve provider and route validity", () => {
 it("caps a generous response at the existing 30s policy, without rewriting its timestamps",()=>{
  const p=quote(), created=Date.parse(p.quotedAt);p.expiresAt=new Date(created+600000).toISOString();const original=p.expiresAt;
  expect(swapQuoteExpiry(p)).toBe(created+30000);expect(p.expiresAt).toBe(original);expect(swapQuoteFresh(p,created+30000)).toBe(false);
 });
 it("honors a genuinely shorter expiry, including the exact expiry boundary",()=>{
  const p=quote(), created=Date.parse(p.quotedAt);p.expiresAt=new Date(created+1000).toISOString();
  expect(swapQuoteFresh(p,created+999)).toBe(true);expect(swapQuoteFresh(p,created+1000)).toBe(false);
  expect(swapQuoteNeedsRefresh(p,created+100)).toBe(false);expect(swapQuoteNeedsRefresh(p,created+800)).toBe(true);
 });
 it("requests review-time refresh near expiry, not on every render",()=>{const p=quote(),created=Date.parse(p.quotedAt);expect(swapQuoteNeedsRefresh(p,created+1000)).toBe(false);expect(swapQuoteNeedsRefresh(p,created+26000)).toBe(true);});
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
