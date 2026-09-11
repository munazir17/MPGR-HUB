import { NextResponse } from "next/server";
import { protectApiRequest, readJsonBody, withRequestId } from "@/lib/api/request-guard";
import { getSessionFromRequest } from "@/lib/auth/session";

import {
  canonicalizeAgentKitActionName,
  invokeAgentKitAction,
  isAgentKitErrorPayload,
  mapAgentKitHttpResult,
} from "@/lib/architecture/agentkit";
import { assertPublicHttpsUrl } from "@/lib/x402/x402-discover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  const guard = await protectApiRequest(request, "agentkit-invoke", 30, 60);
  const requestId = guard.requestId;
  if (guard.error) return guard.error;
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), guard.requestId);
  const session = getSessionFromRequest(request);
  if (!session) return json({ error: "Authentication required" }, { status: 401 });
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body: unknown = parsedBody.value;

  if (!isRecord(body) || typeof body.actionName !== "string") {
    return json(
      { error: "actionName must be a string." },
      { status: 400 },
    );
  }

  const args = isRecord(body.args) ? body.args : {};
  const actionName = canonicalizeAgentKitActionName(body.actionName.trim());

  if (actionName === "make_http_request") {
    const url = typeof args.url === "string" ? args.url : "";
    try {
      assertPublicHttpsUrl(url);
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : "That resource URL is not allowed.",
          code: "INVALID_URL",
        },
        { status: 400 },
      );
    }
  }

  const invoked = await invokeAgentKitAction({
    actionName,
    args,
    walletAddress: session.wallet,
  });

  if (!invoked.ok) {
    const status =
      invoked.code === "INVALID_INPUT"
        ? 400
        : invoked.code === "ACTION_DENIED" || invoked.code === "PREPARE_ONLY"
          ? 403
          : invoked.code === "ACTION_UNKNOWN"
            ? 404
            : 502;

    return json(
      {
        error: invoked.error,
        code: invoked.code,
      },
      {
        status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  if (isAgentKitErrorPayload(invoked.result)) {
    return json(
      {
        error:
          typeof invoked.result.message === "string"
            ? invoked.result.message
            : "AgentKit action failed.",
        code: "PROVIDER_ERROR",
        result: invoked.result,
      },
      {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  const mapped =
    actionName === "make_http_request" && typeof args.url === "string"
      ? mapAgentKitHttpResult(invoked.result, args.url)
      : null;

  return json(
    {
      actionName: invoked.actionName,
      result: invoked.result,
      ...(mapped
        ? {
            discovery: mapped,
          }
        : {}),
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
