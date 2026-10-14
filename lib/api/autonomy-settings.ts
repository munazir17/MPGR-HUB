import type { AutonomyConfig } from "@/hooks/useAgentAutonomy";
import { fetchWithSession } from "./authenticated-fetch";

// Only non-secret, public feature-flag classifications. Never return env values.
export type PublicGateState = "enabled" | "disabled" | "missing" | "invalid" | "unknown";
export function publicGateState(value: string | undefined): PublicGateState {
  if (!value?.trim()) return "missing";
  if (value.trim().toLowerCase() === "true") return "enabled";
  if (value.trim().toLowerCase() === "false") return "disabled";
  return "invalid";
}
function headerGate(value: string | null): PublicGateState {
  return ["enabled", "disabled", "missing", "invalid"].includes(value ?? "") ? value as PublicGateState : "unknown";
}
export interface AutonomySettingsDiagnostic {
  state: "loading" | "wallet_required" | "loaded" | "http_error" | "invalid_json" | "invalid_response" | "network_error" | "timeout";
  httpStatus?: number;
  runtimeGate?: PublicGateState;
  productionGate?: PublicGateState;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function isAutonomySettings(value: unknown): value is AutonomyConfig {
  if (!record(value) || !["enabled", "emergencyDisabled", "productionGate", "executionAvailable"].every((key) => typeof value[key] === "boolean") || !record(value.limits)) return false;
  const limits = value.limits;
  if (!["maxGoalsPerWallet", "minCooldownSeconds", "maxPolicyTtlDays", "maxSlippageBps"].every((key) => Number.isSafeInteger(limits[key]) && Number(limits[key]) > 0)) return false;
  if (!["maxPerTradeHuman", "maxDailyHuman"].every((key) => typeof limits[key] === "string" && /^\d+(?:\.\d+)?$/.test(limits[key]) && Number.isFinite(Number(limits[key])) && Number(limits[key]) > 0)) return false;
  if (value.delegated !== undefined) {
    if (!record(value.delegated) || ![null, 8453, 84532].includes(value.delegated.chainId as number | null) ||
        (value.delegated.executor !== null && typeof value.delegated.executor !== "string") || typeof value.delegated.walletSigningSupported !== "boolean") return false;
  }
  return true;
}

/** Public settings GET: no SIWE prompt, policy/goal write or activation. */
export async function readAutonomySettings(fetchImpl: typeof fetch = fetchWithSession): Promise<{ config: AutonomyConfig | null; diagnostic: AutonomySettingsDiagnostic }> {
  try {
    const response = await fetchImpl("/api/agent/autonomy/config", { method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const diagnostic = { httpStatus: response.status, runtimeGate: headerGate(response.headers.get("x-mpgr-autonomy-runtime-gate")), productionGate: headerGate(response.headers.get("x-mpgr-autonomy-production-gate")) };
    if (!response.ok) return { config: null, diagnostic: { ...diagnostic, state: "http_error" } };
    let value: unknown;
    try { value = await response.json(); } catch (error) {
      const state = error instanceof SyntaxError ? "invalid_json" : error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "timeout" : "network_error";
      return { config: null, diagnostic: { ...diagnostic, state } };
    }
    if (!isAutonomySettings(value)) return { config: null, diagnostic: { ...diagnostic, state: "invalid_response" } };
    return { config: value, diagnostic: { ...diagnostic, state: "loaded" } };
  } catch (error) {
    return { config: null, diagnostic: { state: error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "timeout" : "network_error" } };
  }
}

export function autonomySettingsReadError(diagnostic: AutonomySettingsDiagnostic | undefined): string | null {
  if (!diagnostic || diagnostic.state === "loaded") return null;
  if (diagnostic.state === "wallet_required") return "Connect your wallet to load the review settings. The settings API itself does not require wallet sign-in.";
  if (diagnostic.state === "loading") return "Autonomy settings are loading. Authorization remains disabled until the response is validated.";
  if (diagnostic.state === "http_error") {
    if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) return `Settings GET returned HTTP ${diagnostic.httpStatus}. Check authorized deployment access, then retry settings. This public endpoint does not require wallet sign-in.`;
    return `Settings GET failed (HTTP ${diagnostic.httpStatus}). ${diagnostic.httpStatus === 429 ? "Wait briefly, then" : "Check service availability and"} retry settings; no goal was created.`;
  }
  if (diagnostic.state === "invalid_json" || diagnostic.state === "invalid_response") return `Settings GET returned ${diagnostic.state === "invalid_json" ? "non-JSON data" : "an invalid settings response"} (HTTP ${diagnostic.httpStatus}). Check deployment access/configuration and retry; no goal was created.`;
  return `${diagnostic.state === "timeout" ? "Timed out" : "Network error"} reading autonomy settings. Check connectivity and retry settings; no goal was created.`;
}
