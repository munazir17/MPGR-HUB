// app/api/agent/complete/route.test.ts
//
// Focused CSRF coverage for this route's direct verifyTrustedOrigin()
// call (added when production auth cookies became SameSite=None — see
// lib/auth/config.ts and lib/api/request-guard.ts). Deliberately does
// NOT mock @/lib/api/request-guard, so the real verifyTrustedOrigin
// runs end to end. Only @/lib/auth/session is mocked, purely as a
// cheap, dependency-free way to observe whether the route reached past
// the origin gate: getSessionFromRequest is the very next thing the
// handler calls after verifyTrustedOrigin, so whether it was invoked
// tells us whether the origin check let the request through, without
// needing an OPENAI_API_KEY or a real upstream call.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getSessionFromRequest = vi.fn<() => { wallet: string } | null>();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));
// Task 6: routes authenticate via the server-side session registry; the
// test keeps driving the same fake through the async entry point.
vi.mock("@/lib/auth/session-store", () => ({
  authenticateRequest: async () => getSessionFromRequest(),
}));


const APP_ORIGIN = "https://mpgrhub.xyz";

function postComplete(headers: Record<string, string> = {}) {
  return new Request(`${APP_ORIGIN}/api/agent/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ systemPrompt: "s", userPrompt: "u" }),
  });
}

describe("POST /api/agent/complete — CSRF (real verifyTrustedOrigin)", () => {
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
    // getSessionFromRequest is only called after verifyTrustedOrigin
    // returns null (allowed) — so this proves the origin check passed.
    expect(getSessionFromRequest).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401); // no session mocked → expected next failure
  });

  it("rejects a cross-origin request with 403 before the protected operation runs", async () => {
    const { POST } = await import("./route");
    const response = await POST(postComplete({ origin: "https://evil.com" }));
    expect(response.status).toBe(403);
    // The route never got past verifyTrustedOrigin, so it never even
    // checked for a session, let alone called OpenAI.
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin/Referer at all", async () => {
    const { POST } = await import("./route");
    const response = await POST(postComplete());
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });
});
