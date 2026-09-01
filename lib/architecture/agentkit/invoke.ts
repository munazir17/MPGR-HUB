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

    // TEMPORARY P3 diagnostic logging (server-side only, never returned
    // to the client/agent). This is the exact boundary where this app's
    // assumptions about AgentKit's make_http_request wire shape meet
    // AgentKit's real return value for the first time. Logs only the
    // action's own output, redacted of anything matching
    // stripSecretsFromPayload's secret-key pattern — never args, never
    // wallet/private-key material. Remove once the real runtime shape
    // for this action is confirmed against a live invocation.
    if (canonical === "make_http_request") {
      try {
        const rawForLog =
          typeof raw === "string"
            ? (() => {
                try {
                  return stripSecretsFromPayload(JSON.parse(raw));
                } catch {
                  return raw.slice(0, 500);
                }
              })()
            : stripSecretsFromPayload(raw);
        console.error("[P3 diagnostic] AgentKit make_http_request raw result", {
          rawType: typeof raw,
          raw: rawForLog,
        });
      } catch {
        // Diagnostic logging must never break the real invocation.
      }
    }

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

    // TEMPORARY P3 diagnostic logging (server-side only). safeErrorMessage()
    // below always collapses every non-prepare-only exception to the same
    // generic string before it is returned — that flattening is intentional
    // for what's returned to the caller, but it means the real error name/
    // message has never been visible anywhere. Log it here, once, without
    // altering the returned contract.
    console.error("[P3 diagnostic] invokeAgentKitAction threw", {
      actionName: canonical,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });

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
