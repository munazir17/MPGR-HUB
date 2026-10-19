// app/api/agent/autonomy/config/route.ts
//
// Public runtime status for the autonomy UI gate (spec §19/§23). Returns
// ONLY flags and limits — no user data, no session required. When
// `enabled` is false the client renders nothing and the rest of the API
// refuses to act, so the existing agent experience is untouched.

import { NextResponse } from "next/server";

import { autonomyStatus } from "@/lib/autonomy";
import { publicGateState, publicDeploymentEnvironment } from "@/lib/api/autonomy-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(autonomyStatus(), { headers: {
    "Cache-Control": "no-store",
    "X-MPGR-Autonomy-Deployment-Environment": publicDeploymentEnvironment(process.env.VERCEL_ENV),
    // Classifications only; body schema and all execution gates unchanged.
    "X-MPGR-Autonomy-Runtime-Gate": publicGateState(process.env.MPGR_AUTONOMOUS_AGENT_ENABLED),
    "X-MPGR-Autonomy-Production-Gate": publicGateState(process.env.AUTONOMOUS_PRODUCTION_ENABLED),
  } });
}
