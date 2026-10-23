// app/api/agent/autonomy/config/route.ts
//
// Public runtime status for the autonomy UI gate (spec §19/§23). Returns
// ONLY flags and limits — no user data, no session required. When
// `enabled` is false the client renders nothing and the rest of the API
// refuses to act, so the existing agent experience is untouched.

import { NextResponse } from "next/server";

import { autonomyStatus, bootstrapAutonomyPosture } from "@/lib/autonomy";
import { publicGateState, publicDeploymentEnvironment } from "@/lib/api/autonomy-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POSTURE_WAIT_MS = 8_000;

export async function GET() {
  // A cold instance reports executionAvailable=false until the on-chain
  // posture cache is warm (ONCHAIN_CHECK_PENDING). Await that read-only
  // check so the public status matches the gates that are actually on.
  // Nothing here signs or broadcasts. A timeout leaves the fail-closed flag.
  const runtimeOn = process.env.MPGR_AUTONOMOUS_AGENT_ENABLED?.trim().toLowerCase() === "true";
  const productionOn = process.env.AUTONOMOUS_PRODUCTION_ENABLED?.trim().toLowerCase() === "true";
  if (runtimeOn && productionOn) {
    await Promise.race([
      bootstrapAutonomyPosture().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, POSTURE_WAIT_MS)),
    ]);
  }
  return NextResponse.json(autonomyStatus(), { headers: {
    "Cache-Control": "no-store",
    "X-MPGR-Autonomy-Deployment-Environment": publicDeploymentEnvironment(process.env.VERCEL_ENV),
    // Classifications only; body schema and all execution gates unchanged.
    "X-MPGR-Autonomy-Runtime-Gate": publicGateState(process.env.MPGR_AUTONOMOUS_AGENT_ENABLED),
    "X-MPGR-Autonomy-Production-Gate": publicGateState(process.env.AUTONOMOUS_PRODUCTION_ENABLED),
  } });
}
