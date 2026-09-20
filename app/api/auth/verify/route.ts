import { NextResponse } from "next/server";
import type { Address } from "viem";
import { isNonceActive, consumeNonce } from "@/lib/auth/nonce";
import { issueSession } from "@/lib/auth/session-store";
import { NONCE_COOKIE, SESSION_COOKIE, SUPPORTED_CHAIN_ID, getAppOrigin, getAuthCookieAttributes } from "@/lib/auth/config";
import { buildSiweMessage, verifySiweSignature } from "@/lib/auth/siwe";
import { assertJsonBodyLimit, enforceRateLimit, requestIdFromRequest, withRequestId, readJsonBody } from "@/lib/api/request-guard";
import { readCookieValue } from "@/lib/api/cookies";
import { logApi } from "@/lib/observability/log";
import { formatAddress } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type AuthVerifyFailedStage =
  | "missing_nonce"
  | "nonce_invalid"
  | "message_mismatch"
  | "signature_invalid";

function logVerifyFailure(
  stage: AuthVerifyFailedStage,
  requestId: string,
  extra: Record<string, unknown> = {},
): void {
  logApi("warn", "auth_verify_failed", {
    requestId,
    auth_verify_failed_stage: stage,
    ...extra,
  });
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  const sizeError = await assertJsonBodyLimit(request);
  if (sizeError) return withRequestId(sizeError, requestId);
  const rateError = await enforceRateLimit(request, "auth-verify", 10, 60);
  if (rateError) return withRequestId(rateError, requestId);
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body: unknown = parsedBody.value;
  if (!body || typeof body !== "object") return json({ error: "Invalid request" }, { status: 400 });
  const value = body as Record<string, unknown>;
  if (typeof value.address !== "string" || typeof value.message !== "string" || typeof value.signature !== "string") {
    return json({ error: "address, message and signature are required" }, { status: 400 });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(value.address) || !/^0x[0-9a-fA-F]+$/.test(value.signature)) {
    return json({ error: "Invalid wallet credentials" }, { status: 400 });
  }
  const wallet = value.address;
  const nonce = readCookieValue(request.headers.get("cookie") ?? "", NONCE_COOKIE);
  if (!nonce) {
    logVerifyFailure("missing_nonce", requestId, {
      wallet: formatAddress(wallet),
      cookieHeaderPresent: Boolean(request.headers.get("cookie")),
    });
    return json({ error: "Missing authentication nonce" }, { status: 401 });
  }
  if (!(await isNonceActive(nonce))) {
    logVerifyFailure("nonce_invalid", requestId, { wallet: formatAddress(wallet) });
    return json({ error: "Nonce expired or already used" }, { status: 401 });
  }

  const origin = getAppOrigin(request.url);
  const issued = (value.message as string).match(/Issued At: (.+)/)?.[1];
  const expires = (value.message as string).match(/Expiration Time: (.+)/)?.[1];
  const expected = {
    domain: new URL(origin).host,
    address: value.address as Address,
    uri: origin,
    nonce,
    issuedAt: issued ?? "",
    expirationTime: expires ?? "",
    chainId: SUPPORTED_CHAIN_ID,
  };
  const canonical = buildSiweMessage(expected);
  if (value.message !== canonical) {
    logVerifyFailure("message_mismatch", requestId, {
      wallet: formatAddress(wallet),
      expectedHost: expected.domain,
    });
    return json({ error: "Invalid authentication message" }, { status: 401 });
  }
  let valid = false;
  try {
    valid = await verifySiweSignature(value.message, value.signature as `0x${string}`, expected);
  } catch {
    valid = false;
  }
  if (!valid) {
    logVerifyFailure("signature_invalid", requestId, { wallet: formatAddress(wallet) });
    return json({ error: "Wallet signature verification failed" }, { status: 401 });
  }
  if (!(await consumeNonce(nonce))) return json({ error: "Nonce expired or already used" }, { status: 409 });
  let sessionCookie: string;
  let session: Awaited<ReturnType<typeof issueSession>>["session"];
  try {
    ({ value: sessionCookie, session } = await issueSession(value.address as Address));
  } catch (error) {
    console.error("POST /api/auth/verify could not register session", error);
    return json({ error: "Unable to create session" }, { status: 503 });
  }
  const response = NextResponse.json({
    authenticated: true,
    wallet: session.wallet,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  });
  const cookie = getAuthCookieAttributes();
  response.cookies.set(SESSION_COOKIE, sessionCookie, {
    ...cookie,
    maxAge: session.expiresAt - Math.floor(Date.now() / 1000),
  });
  response.cookies.set(NONCE_COOKIE, "", {
    ...cookie,
    maxAge: 0,
  });
  logApi("info", "wallet_session_created", { requestId, wallet: session.wallet });
  return withRequestId(response, requestId);
}
