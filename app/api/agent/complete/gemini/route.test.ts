// app/api/agent/complete/gemini/route.test.ts
//
// Focused CSRF coverage for this route's direct verifyTrustedOrigin()
// call. Same approach as app/api/agent/complete/route.test.ts: does
// NOT mock @/lib/api/request-guard (real verifyTrustedOrigin runs),
// and mocks only @/lib/auth/session so we can observe whether the
// route reached past the origin gate without needing a GEMINI_API_KEY
// or a real upstream call.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getSessionFromRequest = vi.fn<() => { wallet: string } | null>();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));

const APP_ORIGIN = "https://mpgrhub.xyz";

function postComplete(headers: Record<string, string> = {}) {
  return new Request(`${APP_ORIGIN}/api/agent/complete/gemini`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ systemPrompt: "s", userPrompt: "u" }),
  });
}

describe("POST /api/agent/complete/gemini — CSRF (real verifyTrustedOrigin)", () => {
  let savedAppOrigin: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedAppOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = APP_ORIGIN;
    getSessionFromRequest.mockReturnValue(null);
  });

  afterEach(() => {
    if (savedAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedAppOrigin;
  });

  it("lets a trusted-origin request reach the route's own logic (past the origin gate)", async () => {
    const { POST } = await import("./route");
    const response = await POST(postComplete({ origin: APP_ORIGIN }));
    expect(getSessionFromRequest).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
  });

  it("rejects a cross-origin request with 403 before the protected operation runs", async () => {
    const { POST } = await import("./route");
    const response = await POST(postComplete({ origin: "https://evil.com" }));
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin/Referer at all", async () => {
    const { POST } = await import("./route");
    const response = await POST(postComplete());
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });
});
