import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE } from "./config";
import { createSession, getSessionFromRequest, readSession } from "./session";

const SECRET = "test-auth-session-secret-value-32chars";
const WALLET = "0xd57b0000000000000000000000000000000095f7" as const;

describe("wallet session cookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips a valid session from the request Cookie header", () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    const { value, session } = createSession(WALLET);
    const request = new Request("https://mpgrhub.xyz/api/trade/stocks/quote", {
      headers: { cookie: `${SESSION_COOKIE}=${value}` },
    });
    const read = getSessionFromRequest(request);
    expect(read?.wallet).toBe(session.wallet);
    expect(read?.sessionId).toBe(session.sessionId);
  });

  it("rejects a missing session cookie", () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    const request = new Request("https://mpgrhub.xyz/api/trade/stocks/quote");
    expect(getSessionFromRequest(request)).toBeNull();
  });

  it("rejects a tampered session cookie", () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    const { value } = createSession(WALLET);
    expect(readSession(`${value}tampered`)).toBeNull();
  });

  it("rejects an expired session", () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { value } = createSession(WALLET);
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    expect(readSession(value)).toBeNull();
    vi.useRealTimers();
  });
});
