// V2 activation status. Read-only, public, no secrets and no chain access: it
// reports only whether the app is currently allowed to return an executable V2
// transaction, so the client can pick an engine without adding a request to
// every live V1 quote.
//
// While `V2_DEPLOYMENT` is null this always reports `activated:false`, and the
// swap UI behaves exactly as it does today.
import { NextResponse } from "next/server";
import { swapV2Executor, swapV2RoutingActivated } from "@/lib/swap/v2/deployment";
import { SWAP_V2_CHAIN_ID } from "@/lib/swap/v2/deployment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const activated = swapV2RoutingActivated();
  const deployment = activated ? swapV2Executor() : null;
  return NextResponse.json(
    {
      activated,
      chainId: SWAP_V2_CHAIN_ID,
      // Public on-chain identity, exposed only once routing is genuinely active.
      executor: deployment?.executor ?? null,
      feeBps: deployment?.feeBps ?? null,
      feeRecipient: deployment?.feeRecipient ?? null,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
