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
 const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:quote()}));expect(html.match(/MPGR fee/g)).toHaveLength(1);expect(html.match(/mpgr-fee-row/g)).toHaveLength(1);expect(html).toContain("0.0025 USDC");expect(html).toContain("collection not verified");expect(html).not.toContain("the executor takes its fee");
});
it("expired quoted amounts do not claim an executable included/collected fee",()=>{
 const p=quote();p.expiresAt=new Date(Date.now()-1).toISOString();const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:p}));expect(html).toContain("quote expired");expect(html).not.toContain("included in executable route");
});
it("an unsupported proposal is blocked even if a caller mistakenly asks for verified display",()=>{
 const p=quote();p.provider="cdp-trade-api";const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:p,feeState:"verified"}));expect(html).toContain("swap blocked");expect(html).not.toContain("collection verified");expect(html).not.toContain("included in executable route");
});
it("no quote shows an unverified amount, not a fabricated zero charge or waiver",()=>{
 const html=renderToStaticMarkup(createElement(SwapDetails,{proposal:null,issue:"No supported quote"}));expect(html.match(/mpgr-fee-row/g)).toHaveLength(1);expect(html).toContain("Amount unavailable");expect(html).toContain("unsupported/unverified");expect(html).toContain('role="alert"');
});
