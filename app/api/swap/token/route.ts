import { swapDiscoveryApi } from "@/lib/swap/swap-discovery-api";
import { exactSwapAddress, swapDiscoveryClient } from "@/lib/swap/swap-discovery-read";
import { inspectSwapToken } from "@/lib/swap/swap-token-metadata";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return swapDiscoveryApi(request, "token", async body => {
    const address = exactSwapAddress(body.address);
    return inspectSwapToken(swapDiscoveryClient(request.signal), address);
  });
}
