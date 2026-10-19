import { afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ status: { enabled: false, productionGate: false, executionAvailable: false } }));
vi.mock("@/lib/autonomy", () => ({ autonomyStatus: vi.fn(() => fixture.status) }));
import { GET } from "./route";
afterEach(() => vi.unstubAllEnvs());
it.each(["preview", "production", "development", undefined, "private-custom-env"])("exposes only a classified deployment environment (%s); body and closed gates stay unchanged", async (environment) => {
  if (environment === undefined) vi.stubEnv("VERCEL_ENV", undefined);
  else vi.stubEnv("VERCEL_ENV", environment);
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "false");
  vi.stubEnv("AUTONOMOUS_PRODUCTION_ENABLED", undefined);
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-MPGR-Autonomy-Deployment-Environment")).toBe(["preview", "production", "development"].includes(environment ?? "") ? environment : "unknown");
  expect(response.headers.get("X-MPGR-Autonomy-Runtime-Gate")).toBe("disabled");
  expect(response.headers.get("X-MPGR-Autonomy-Production-Gate")).toBe("missing");
  expect(await response.json()).toEqual(fixture.status);
  expect(response.headers.get("X-MPGR-Autonomy-Deployment-Environment")).not.toContain("private-custom-env");
});
