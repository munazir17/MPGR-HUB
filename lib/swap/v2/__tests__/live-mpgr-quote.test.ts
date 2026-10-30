import { describe, expect, it } from "vitest";
import { discoverV2Quote } from "../discovery";
import { swapV2QuoteSource } from "../rpc-source";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MPGR = "0xb2000000000000000000008d204203177a78af01";
const FIVE_USDC = 5_000_000n;

describe.skipIf(!process.env.LIVE_MPGR_QUOTE)("live Base USDC/MPGR quote", () => {
  it("quotes both directions with one 25 bps fee and does not sign", async () => {
    const client = getTradePublicClient();
    expect(await client.getChainId()).toBe(8453);
    const block = await client.getBlock();
    const source = swapV2QuoteSource(client, block.number!);
    const forward = await discoverV2Quote(source, USDC, MPGR, FIVE_USDC);
    expect(forward.fee).toBe(FIVE_USDC * 25n / 10_000n);
    expect(forward.amountOut).toBeGreaterThan(0n);
    expect(forward.legs[0].pools.length).toBeGreaterThan(0);
    const backGross = forward.amountOut;
    const back = await discoverV2Quote(swapV2QuoteSource(client, block.number!), MPGR, USDC, backGross);
    expect(back.fee).toBe(backGross * 25n / 10_000n);
    expect(back.amountOut).toBeGreaterThan(0n);
    console.log(JSON.stringify({
      forwardOut: forward.amountOut.toString(),
      forwardFee: forward.fee.toString(),
      forwardHops: forward.legs[0].pools.map((p) => p.kind),
      backOut: back.amountOut.toString(),
      backFee: back.fee.toString(),
      backHops: back.legs[0].pools.map((p) => p.kind),
    }));
  }, 120_000);
});
