// lib/architecture/agentkit/allowed-actions.ts
//
// Allowlist — not a denylist. AgentKit ships write actions that sign
// and pay automatically (native_transfer, make_http_request_with_x402).
// Those must never be reachable from the MPGR Agent loop.
//
// AgentKit 0.10.4 prefixes action names with the provider class
// (e.g. WalletActionProvider_get_wallet_details). Callers may pass
// either the short docs name or the prefixed runtime name; both are
// canonicalized before the allowlist is applied.

export const AGENTKIT_READ_ACTIONS = [
  "get_wallet_details",
  "make_http_request",
  "discover_x402_services",
  "mpgr_onchain_policy",
] as const;

export const AGENTKIT_PREPARE_ACTIONS = [] as const;

export const AGENTKIT_DENIED_ACTIONS = [
  "native_transfer",
  "retry_http_request_with_x402",
  "make_http_request_with_x402",
  "register_x402_service",
] as const;

export type AgentKitReadAction = (typeof AGENTKIT_READ_ACTIONS)[number];
export type AgentKitDeniedAction = (typeof AGENTKIT_DENIED_ACTIONS)[number];
export type AgentKitAllowedAction = AgentKitReadAction;

const ALLOWED = new Set<string>(AGENTKIT_READ_ACTIONS);
const DENIED = new Set<string>(AGENTKIT_DENIED_ACTIONS);

const AGENTKIT_CLASS_PREFIXES = [
  "WalletActionProvider_",
  "X402ActionProvider_",
  "CustomActionProvider_",
] as const;

export function canonicalizeAgentKitActionName(name: string): string {
  const trimmed = name.trim();
  for (const prefix of AGENTKIT_CLASS_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

export function isDeniedAgentKitAction(name: string): boolean {
  return DENIED.has(canonicalizeAgentKitActionName(name));
}

export function isAllowedAgentKitAction(
  name: string,
): name is AgentKitAllowedAction {
  return ALLOWED.has(canonicalizeAgentKitActionName(name));
}

export function classifyAgentKitAction(
  name: string,
): "read" | "denied" | "unknown" {
  const canonical = canonicalizeAgentKitActionName(name);
  if (DENIED.has(canonical)) return "denied";
  if (ALLOWED.has(canonical)) return "read";
  return "unknown";
}
