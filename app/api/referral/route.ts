import { NextResponse } from "next/server";
import { protectApiRequest, readJsonBody, withRequestId } from "@/lib/api/request-guard";
import { referralStore } from "@/lib/referral/referral-store";
import { authenticateRequest } from "@/lib/auth/session-store";
import { logApi } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: Request) {
  const session = await authenticateRequest(request);
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");

  if (!wallet || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  if (!session || session.wallet.toLowerCase() !== wallet.toLowerCase()) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const count = await referralStore.getReferralCount(wallet);
    return NextResponse.json({ count });
  } catch (error) {
    console.error("GET /api/referral failed:", error);
    return NextResponse.json({ error: "Failed to load referral count" }, { status: 500 });
  }
}

interface ReferralRequestBody {
  referrer: string;
}

function isValidShape(value: unknown): value is ReferralRequestBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.referrer === "string";
}

export async function POST(request: Request) {
  const guard = await protectApiRequest(request, "referral", 20, 60);
  const requestId = guard.requestId;
  if (guard.error) return guard.error;
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), guard.requestId);
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body = parsedBody.value;

  if (!isValidShape(body) || !ADDRESS_RE.test(body.referrer)) {
    return json({ error: "Body must be { referrer: 0x-address }" }, { status: 400 });
  }

  const session = await authenticateRequest(request);
  if (!session) return json({ error: "Authentication required" }, { status: 401 });

  try {
    // The REFERRED wallet is always the authenticated session wallet —
    // the client only ever supplies the referrer, never a victim identity.
    const result = await referralStore.registerReferral(body.referrer, session.wallet);
    const attempted = body.referrer.toLowerCase();
    if (result.status === "self-referral") {
      logApi("warn", "referral.abuse.self", { wallet: attempted, requestId });
      await referralStore.recordReferralAbuse(attempted);
    } else if (result.status === "already-attributed" && result.referrer !== attempted) {
      // Someone with a valid session tried to re-point an already
      // attributed wallet at a different referrer. Attribution is
      // first-write-wins, so this can never succeed — count it.
      logApi("warn", "referral.abuse.attribution-steal", {
        wallet: attempted,
        walletExisting: result.referrer,
        requestId,
      });
      await referralStore.recordReferralAbuse(attempted);
    } else if (result.status === "registered") {
      // Task 8: the +100 XP reward is NOT paid here anymore. Registration
      // leaves a durable pending record; payment happens via
      // settleReferralReward only after the referred wallet shows genuine
      // server-awarded activity, the referrer exists in the ledger, and
      // the referrer's daily reward cap has room. The claim is atomic and
      // the ledger event key dedupes across replays — so an attempt at
      // immediate settlement (e.g. an EXISTING user arriving via a fresh
      // ?ref= link) is harmless, and a brand-new referred wallet just
      // defers to its first check-in.
      await referralStore.settleReferralReward(session.wallet);
    }
    return json(result);
  } catch (error) {
    console.error("POST /api/referral failed:", error);
    return json({ error: "Failed to register referral" }, { status: 500 });
  }
}
