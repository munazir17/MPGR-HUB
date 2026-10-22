import { it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SwapDetails } from "./SwapDetails";
import { simulatedExecutorQuote } from "@/tests/mobile/flow-fixtures";
import { chatDraftToForm } from "@/components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
const prompt="Buy AAPLc whenever price falls below $200 worth 1 USDC";
const quote=()=>simulatedExecutorQuote(chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!,prompt)));
it("renders one exact fee amount/asset in the costs row, without repeating the approval fee explanation",()=>{
 const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:quote()}));expect(html.match(/Paiger fee/g)).toHaveLength(1);expect(html.match(/mpgr-fee-row/g)).toHaveLength(1);expect(html).toContain("0.0025 USDC");expect(html).toContain("included");expect(html).not.toContain("the executor takes its fee");
});
it("expired quoted amounts do not claim an executable included/collected fee",()=>{
 const p=quote();p.expiresAt=new Date(Date.now()-1).toISOString();const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:p}));expect(html).toContain("quote expired");expect(html).not.toContain(">included<");
});
it("an unsupported proposal is blocked even if a caller mistakenly asks for verified display",()=>{
 const p=quote();p.provider="cdp-trade-api";const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:p,feeState:"verified"}));expect(html).toContain("not applied");expect(html).not.toContain(">collected<");
});
it("no quote shows an unverified amount, not a fabricated zero charge or waiver",()=>{
 const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:null,issue:"No supported quote"}));expect(html.match(/mpgr-fee-row/g)).toHaveLength(1);expect(html).toContain("Quote required");expect(html).toContain('role="alert"');
});

it.each(["sell", "buy"] as const)("native %s is not displayed as an ERC20 contract", side=>{
 const form=chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!,prompt));
 const native="0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
 const p=simulatedExecutorQuote({...form, sell:side==="sell"?native:form.sell, buy:side==="buy"?native:form.sell});
 const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:p}));expect(html).not.toContain(native);
});

import { keccak256 } from "viem";
import { swapRouteCandidates, swapRouteKey, type SwapRoutedProposal } from "@/lib/swap/swap-route-candidates";
it("dynamic search explains comparison bounds, partial evidence, gas scope and execution limitations without extra fee rows",()=>{
 const p:SwapRoutedProposal=quote();const routes=swapRouteCandidates(p.from.address,p.to.address),route=routes.find(r=>r.kind===1)!;
 p.swapRouting={version:1,hops:1,route,pool:"0x7777777777777777777777777777777777777777",blockNumber:"100",blockHash:`0x${"ab".repeat(32)}`,calldataHash:keccak256(p.transaction!.data),selection:"highest-quoted-output",comparisonComplete:false,
 outcomes:routes.map(r=>({key:swapRouteKey(r),state:r.kind===1?"quoted":"unavailable",reason:"OFFLINE_TEST_ONLY",output:r.kind===1?p.toAmount:null})),quoterGasUnits:"10000",executionSimulation:"not-run-wallet-preflight-required"};
 const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:p}));
 expect(html).toContain("Minimum received");expect(html).toContain("Paiger fee");expect(html.match(/mpgr-fee-row/g)).toHaveLength(1);
 expect(html).not.toContain("owner-mutable");expect(html).not.toContain("Multi-hop and V4 are unsupported");
});
