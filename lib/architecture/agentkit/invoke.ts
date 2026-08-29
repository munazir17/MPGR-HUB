import "server-only";

import {
  canonicalizeAgentKitActionName,
  classifyAgentKitAction,
  isAllowedAgentKitAction,
} from "./allowed-actions";
import { createMpgrAgentKit } from "./runtime";
import { isPrepareOnlyError } from "./prepare-only-wallet";
import { PREPARE_ONLY_ERROR } from "./config";
import { parseAgentKitResult } from "./map-x402";
import { assertPublicHttpsUrl } from "@/lib/x402/x402-discover";

export interface AgentKitInvokeRequest {
  actionName: string;
  args?: Record<string, unknown>;
  walletAddress?: string;
}

export type AgentKitInvokeResult =
  | {
      ok: true;
      actionName: string;
      result: unknown;
    }
  | {
      ok: false;
      code:
        | "ACTION_DENIED"
        | "ACTION_UNKNOWN"
        | "INVALID_INPUT"
        | "PREPARE_ONLY"
        | "PROVIDER_ERROR";
      error: string;
    };

const SECRET_KEY_RE =
  /(?:cdp[_-]?api[_-]?key|cdp[_-]?wallet[_-]?secret|private[_-]?key|api[_-]?secret|wallet[_-]?secret)/i;

export function stripSecretsFromPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSecretsFromPayload);
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SECRET_KEY_RE.test(key)) continue;
      output[key] = stripSecretsFromPayload(nested);
    }
    return output;
  }

  return value;
}

function safeErrorMessage(error: unknown): string {
  if (isPrepareOnlyError(error)) {
    return PREPARE_ONLY_ERROR;
  }
  return "AgentKit could not complete that onchain action.";
}

function assertHttpActionUrl(
  canonical: string,
  args: Record<string, unknown>,
): AgentKitInvokeResult | null {
  if (canonical !== "make_http_request") {
    return null;
  }

  const url = typeof args.url === "string" ? args.url : "";

  try {
    assertPublicHttpsUrl(url);
    return null;
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      error:
        error instanceof Error
          ? error.message
          : "That resource URL is not allowed.",
    };
  }
}

export async function invokeAgentKitAction(
  request: AgentKitInvokeRequest,
): Promise<AgentKitInvokeResult> {
  const actionName =
    typeof request.actionName === "string" ? request.actionName.trim() : "";

  if (!actionName) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      error: "actionName is required.",
    };
  }

  const canonical = canonicalizeAgentKitActionName(actionName);
  const classification = classifyAgentKitAction(canonical);

  if (classification === "denied") {
    return {
      ok: false,
      code: "ACTION_DENIED",
      error: PREPARE_ONLY_ERROR,
    };
  }

  if (!isAllowedAgentKitAction(canonical)) {
    return {
      ok: false,
      code: "ACTION_UNKNOWN",
      error: `Action "${canonical}" is not available through the MPGR AgentKit layer.`,
    };
  }

  const args = request.args ?? {};
  const blockedUrl = assertHttpActionUrl(canonical, args);
  if (blockedUrl) {
    return blockedUrl;
  }

  try {
    const agentKit = await createMpgrAgentKit({
      walletAddress: request.walletAddress,
    });

    const action = agentKit
      .getActions()
      .find(
        (item) => canonicalizeAgentKitActionName(item.name) === canonical,
      );

    if (!action) {
      return {
        ok: false,
        code: "ACTION_UNKNOWN",
        error: `Action "${canonical}" is not registered on this AgentKit instance.`,
      };
    }

    const raw = await action.invoke(args);
    const result = stripSecretsFromPayload(parseAgentKitResult(raw));

    return {
      ok: true,
      actionName: canonical,
      result,
    };
  } catch (error) {
    if (isPrepareOnlyError(error)) {
      return {
        ok: false,
        code: "PREPARE_ONLY",
        error: PREPARE_ONLY_ERROR,
      };
    }

    return {
      ok: false,
      code: "PROVIDER_ERROR",
      error: safeErrorMessage(error),
    };
  }
}

export async function listAllowedAgentKitActions(options?: {
  walletAddress?: string;
}): Promise<Array<{ name: string; description: string; mode: "read" }>> {
  const agentKit = await createMpgrAgentKit({
    walletAddress: options?.walletAddress,
  });

  return agentKit
    .getActions()
    .filter((action) => isAllowedAgentKitAction(action.name))
    .map((action) => ({
      name: canonicalizeAgentKitActionName(action.name),
      description: action.description,
      mode: "read" as const,
    }));
}
