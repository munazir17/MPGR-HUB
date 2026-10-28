// V2 activation status. Read-only, public, no secrets and no chain access.
// Reports whether this build's source gate currently allows an executable V2
// transaction. It does not prove a wallet-confirmed mainnet swap.
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
