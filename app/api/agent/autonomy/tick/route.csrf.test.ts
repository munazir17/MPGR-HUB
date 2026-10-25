// CSRF regression: the session cookie is SameSite=None in production.
// POST /api/agent/autonomy/tick must not evaluate a wallet unless the
// browser Origin is this app. Cron bearer auth does not use the cookie
// and must keep working with no Origin header.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const APP_ORIGIN = "https://mpgrhub.xyz";
const tick = vi.fn(async (_input: { wallet?: string }) => ({
  ranAt: "now",
  scanned: 0,
  evaluated: 0,
  skippedBusy: 0,
  disabled: false,
  results: [] as { kind: string }[],
}));

vi.mock("@/lib/autonomy", () => ({ bootstrapAutonomyPosture: async () => undefined }));
vi.mock("@/lib/autonomy/api-helpers", () => ({
  system: () => ({ scheduler: { tick } }),
}));
vi.mock("@/lib/auth/session-store", () => ({
  authenticateRequest: async () => ({ sessionId: "b".repeat(32), wallet: WALLET, issuedAt: 1, expiresAt: 2 }),
}));
vi.mock("@/lib/trade/trade-rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  clientIpFromRequest: () => "127.0.0.1",
}));

import { POST } from "./route";

describe("autonomy tick CSRF", () => {
  beforeEach(() => {
    tick.mockClear();
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "cron-secret-value");
  });

  it("rejects a cross-site session POST before any evaluation", async () => {
    const response = await POST(new Request(`${APP_ORIGIN}/api/agent/autonomy/tick`, {
      method: "POST",
      headers: { origin: "https://evil.example", cookie: "mpgr_session=victim" },
    }));
    expect(response.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("rejects a session POST that omits Origin", async () => {
    const response = await POST(new Request(`${APP_ORIGIN}/api/agent/autonomy/tick`, {
      method: "POST",
      headers: { cookie: "mpgr_session=victim" },
    }));
    expect(response.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("accepts a same-origin session POST and scopes the tick to that wallet", async () => {
    const response = await POST(new Request(`${APP_ORIGIN}/api/agent/autonomy/tick`, {
      method: "POST",
      headers: { origin: APP_ORIGIN, cookie: "mpgr_session=victim" },
    }));
    expect(response.status).toBe(200);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ wallet: WALLET.toLowerCase() }));
  });

  it("still accepts a cron bearer POST with no Origin header", async () => {
    const response = await POST(new Request(`${APP_ORIGIN}/api/agent/autonomy/tick`, {
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value" },
    }));
    expect(response.status).toBe(200);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ wallet: undefined }));
  });
});
