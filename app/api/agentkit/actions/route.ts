import { NextResponse } from "next/server";

import { listAllowedAgentKitActions } from "@/lib/architecture/agentkit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const actions = await listAllowedAgentKitActions();

    return NextResponse.json(
      {
        network: "base-mainnet",
        chainId: 8453,
        signing: "user-wallet-only",
        actions,
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      {
        error: "Could not list AgentKit actions.",
        code: "PROVIDER_ERROR",
      },
      { status: 502 },
    );
  }
}
