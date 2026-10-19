import { swapDiscoveryApi } from "@/lib/swap/swap-discovery-api";
import { exactSwapAddress, swapDiscoveryClient } from "@/lib/swap/swap-discovery-read";
import { discoverSwapLiquidity } from "@/lib/swap/swap-liquidity";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return swapDiscoveryApi(request, "liquidity", async body => {
    const from = exactSwapAddress(body.fromToken), to = exactSwapAddress(body.toToken);
    return discoverSwapLiquidity(swapDiscoveryClient(request.signal), from, to);
  });
}
