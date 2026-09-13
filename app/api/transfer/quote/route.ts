import { NextResponse } from "next/server";

import { buildTransferProposal } from "@/lib/trade/transfer-proposal";
import { parseTransferRequest } from "@/lib/trade/transfer-request";
import { protectApiRequest, withRequestId } from "@/lib/api/request-guard";
import { getSessionFromRequest } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 15;
const RATE_WINDOW_SECONDS = 60;

export async function POST(request: Request) {
  const { requestId, error: guardError } = await protectApiRequest(
    request,
    "transfer-quote",
    RATE_LIMIT,
    RATE_WINDOW_SECONDS,
  );
  if (guardError) return guardError;

  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);

  // SECURITY: the sender is always the authenticated session wallet.
  // Nothing in the request body is ever trusted for who is sending —
  // see lib/trade/transfer-request.ts, which does not even read a
  // sender/from field.
  const session = getSessionFromRequest(request);
  if (!session) {
    return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body", code: "INVALID_INPUT" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const parsed = await parseTransferRequest(body);
  if (!parsed.ok) {
    const status = parsed.error.code === "WALLET_REQUIRED" ? 401 : 400;
    return json({ error: parsed.error.message, code: parsed.error.code }, { status, headers: { "Cache-Control": "no-store" } });
  }

  const result = await buildTransferProposal({ parsed: parsed.value, sender: session.wallet });
  if (!result.ok) {
    const status = result.error.code === "WALLET_REQUIRED" ? 401 : result.error.code === "PROVIDER_ERROR" ? 502 : 400;
    return json({ error: result.error.message, code: result.error.code }, { status, headers: { "Cache-Control": "no-store" } });
  }

  return json({ proposal: result.proposal }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
