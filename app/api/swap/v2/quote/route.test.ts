import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({parse:vi.fn(),quote:vi.fn(),client:{getChainId:vi.fn(),getBlock:vi.fn()}}));
vi.mock("@/lib/auth/session-store",()=>({authenticateRequest:async()=>({wallet:"0x0000000000000000000000000000000000000123"})}));
vi.mock("@/lib/api/request-guard",()=>({verifyTrustedOrigin:()=>null,readJsonBody:async(r:Request)=>({ok:true,value:await r.json()})}));
vi.mock("@/lib/trade/trade-rate-limit",()=>({checkRateLimit:async()=>({allowed:true}),clientIpFromRequest:()=>"test"}));
vi.mock("@/lib/trade/trade-request",()=>({parseTradeSwapRequest:mocks.parse}));
vi.mock("@/lib/trade/trade-public-client",()=>({getTradePublicClient:()=>mocks.client}));
vi.mock("@/lib/swap/v2/rpc-source",()=>({RpcV2LiquiditySource:class {}}));
vi.mock("@/lib/swap/v2/discovery",async(importOriginal)=>({...await importOriginal<typeof import("@/lib/swap/v2/discovery")>(),discoverV2Quote:mocks.quote}));
import { POST } from "./route";
import { V2QuoteError } from "@/lib/swap/v2/discovery";
const A="0x0000000000000000000000000000000000000101",B="0x0000000000000000000000000000000000000102";
function request(extra={}) {return new Request("https://mpgr.test/api/swap/v2/quote",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fromToken:A,toToken:B,fromAmount:"10000",...extra})});}
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.parse.mockResolvedValue({ok:true,value:{from:{address:A},to:{address:B},fromAmount:"10000"}});
  mocks.client.getChainId.mockResolvedValue(8453);mocks.client.getBlock.mockResolvedValue({number:500n,hash:("0x"+"12".repeat(32))});
  mocks.quote.mockResolvedValue({tokenIn:A,tokenOut:B,gross:10000n,fee:25n,net:9975n,feeBps:25,amountOut:1000n});
});
describe("unreleased V2 quote HTTP boundary",()=>{
  it("accepts two imported validated tokens, but returns no executable mainnet transaction",async()=>{
    const r=await POST(request());const body=await r.json();expect(r.status).toBe(200);
    expect(mocks.quote).toHaveBeenCalledWith(expect.anything(),A,B,10000n);
    expect(body).toMatchObject({preview:true,executable:false,transaction:null,executionSimulation:"not-run-unreleased",quote:{fee:"25",net:"9975"}});
  });
  it("rejects fee opt-out, a forged bps, or a redirected recipient before discovery",async()=>{
    for(const extra of [{requireMPGRFee:false},{feeBps:0},{feeBps:26},{feeRecipient:A}]) expect((await POST(request(extra))).status).toBe(400);
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it("reports no route as LIQUIDITY_UNAVAILABLE, never a token-registry veto",async()=>{
    mocks.quote.mockRejectedValue(new V2QuoteError("LIQUIDITY_UNAVAILABLE","No liquid route"));
    const r=await POST(request());expect(r.status).toBe(422);expect((await r.json()).code).toBe("LIQUIDITY_UNAVAILABLE");
  });
  it("does not call an RPC outage a token/pair liquidity failure",async()=>{
    mocks.quote.mockRejectedValue(new V2QuoteError("DISCOVERY_UNAVAILABLE","Index unavailable"));
    const r=await POST(request());expect(r.status).toBe(503);expect((await r.json()).code).toBe("DISCOVERY_UNAVAILABLE");
  });
  it("checks Base before constructing discovery and never routes to the legacy executor",async()=>{
    mocks.client.getChainId.mockResolvedValue(1);expect((await POST(request())).status).toBe(503);expect(mocks.quote).not.toHaveBeenCalled();
  });
});
