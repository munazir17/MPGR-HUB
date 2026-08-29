import { NextResponse } from "next/server";

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

function readWalletAddress(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value
    : undefined;
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if (!isRecord(body) || typeof body.actionName !== "string") {
    return NextResponse.json(
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
      return NextResponse.json(
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
    walletAddress: readWalletAddress(body.walletAddress),
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

    return NextResponse.json(
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
    return NextResponse.json(
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

  return NextResponse.json(
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
