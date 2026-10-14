import { afterEach, describe, expect, it, vi } from "vitest";
import { autonomySettingsReadError, publicGateState, readAutonomySettings } from "./autonomy-settings";

const config = {
  enabled: false, emergencyDisabled: false, productionGate: false, executionAvailable: false,
  delegated: { chainId: null, executor: null, walletSigningSupported: false },
  limits: { maxGoalsPerWallet: 5, minCooldownSeconds: 60, maxPolicyTtlDays: 30, maxPerTradeHuman: "100", maxDailyHuman: "500", maxSlippageBps: 100 },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());

describe("public autonomy settings diagnostics (GET-only, no signing)", () => {
  it.each([[undefined, "missing"], ["  ", "missing"], ["false", "disabled"], [" FALSE ", "disabled"], [" TrUe ", "enabled"], ["0", "invalid"], ["do-not-expose-this", "invalid"]] as const)("classifies %s without exposing the value", (value, state) => {
    expect(publicGateState(value)).toBe(state);
  });
  it("accepts a disabled response as loaded, preserves no-store/credentials and only GETs public config", async () => {
    const response = json(config);
    response.headers.set("x-mpgr-autonomy-runtime-gate", "missing");
    response.headers.set("x-mpgr-autonomy-production-gate", "disabled");
    const network = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", network);
    const result = await readAutonomySettings();
    expect(result).toEqual({ config, diagnostic: { state: "loaded", httpStatus: 200, runtimeGate: "missing", productionGate: "disabled" } });
    expect(autonomySettingsReadError(result.diagnostic)).toBeNull();
    expect(network).toHaveBeenCalledOnce();
    expect(network).toHaveBeenCalledWith("/api/agent/autonomy/config", expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store", signal: expect.any(AbortSignal) }));
  });
  it.each([401, 403, 404, 429, 500, 503])("preserves HTTP %s, even with a settings-shaped error body", async (status) => {
    const result = await readAutonomySettings(vi.fn<typeof fetch>().mockResolvedValue(json(config, status)));
    expect(result.config).toBeNull();
    expect(result.diagnostic).toMatchObject({ state: "http_error", httpStatus: status });
    expect(autonomySettingsReadError(result.diagnostic)).toContain(`HTTP ${status}`);
  });
  it("distinguishes protected HTML/non-JSON from invalid settings", async () => {
    const html = await readAutonomySettings(vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>restricted</html>")));
    expect(html.diagnostic).toMatchObject({ state: "invalid_json", httpStatus: 200 });
    expect(html.config).toBeNull();
    for (const bad of [null, [], {}, { enabled: true }, { ...config, productionGate: undefined }, { ...config, executionAvailable: "true" }, { ...config, limits: { ...config.limits, maxDailyHuman: "NaN" } }, { ...config, delegated: { chainId: null, executor: null } }]) {
      const result = await readAutonomySettings(vi.fn<typeof fetch>().mockResolvedValue(json(bad)));
      expect(result.config).toBeNull();
      expect(result.diagnostic.state).toBe("invalid_response");
    }
  });
  it("does not expose arbitrary headers or exception bodies", async () => {
    const response = json(config);
    response.headers.set("x-mpgr-autonomy-runtime-gate", "private-value");
    expect((await readAutonomySettings(vi.fn<typeof fetch>().mockResolvedValue(response))).diagnostic.runtimeGate).toBe("unknown");
    const result = await readAutonomySettings(vi.fn<typeof fetch>().mockRejectedValue(new Error("private-body")));
    expect(result).toEqual({ config: null, diagnostic: { state: "network_error" } });
    expect(autonomySettingsReadError(result.diagnostic)).not.toContain("private-body");
  });
  it("reports a bounded timeout separately from network failures", async () => {
    const result = await readAutonomySettings(vi.fn<typeof fetch>().mockRejectedValue(new DOMException("private-url", "TimeoutError")));
    expect(result).toEqual({ config: null, diagnostic: { state: "timeout" } });
  });
});


it("does not label an interrupted response body as malformed JSON", async () => {
  for (const [error, state] of [[new DOMException("private-url", "AbortError"), "timeout"], [new TypeError("private-url"), "network_error"]] as const) {
    const response = json(config);
    vi.spyOn(response, "json").mockRejectedValue(error);
    const result = await readAutonomySettings(vi.fn<typeof fetch>().mockResolvedValue(response));
    expect(result.config).toBeNull();
    expect(result.diagnostic).toMatchObject({ state, httpStatus: 200 });
  }
});
