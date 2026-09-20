// Task 6 — server-side session registry (revocation) tests.
//
// Before this change sessions were purely stateless: an HMAC cookie stayed
// valid for its full 8h lifetime no matter what, so POST /api/auth/logout
// only cleared the browser copy and a captured cookie kept working.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import { SESSION_COOKIE } from "./config";

const redis = new LuaRedis();
let redisAvailable = true;
vi.mock("@/lib/api/redis", () => ({
  getRedis: () => {
    if (!redisAvailable) throw new Error("Upstash Redis environment variables are missing.");
    return redis.client();
  },
}));

const SECRET = "test-auth-session-secret-value-32chars";
const WALLET = "0xd57b0000000000000000000000000000000095f7" as Address;
const OTHER = "0xd57b0000000000000000000000000000000095f8" as Address;

function requestWith(cookie: string, path = "/api/xp") {
  return new Request(`https://mpgrhub.xyz${path}`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
}

describe("session store — issue / validate / revoke", () => {
  beforeEach(() => {
    redis.reset();
    redisAvailable = true;
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("a freshly issued session is accepted by the async validator", async () => {
    const { issueSession, authenticateRequest } = await import("./session-store");
    const { value, session } = await issueSession(WALLET);
    const auth = await authenticateRequest(requestWith(value));
    expect(auth?.wallet).toBe(WALLET.toLowerCase());
    expect(auth?.sessionId).toBe(session.sessionId);
  });

  it("logout revokes the server record so the same cookie value is rejected afterwards", async () => {
    const { issueSession, authenticateRequest, revokeSession } = await import("./session-store");
    const { value, session } = await issueSession(WALLET);
    expect(await authenticateRequest(requestWith(value))).not.toBeNull();

    await revokeSession(session);

    expect(await authenticateRequest(requestWith(value))).toBeNull();
  });

  it("revokeSession is idempotent and scoped to one sessionId", async () => {
    const { issueSession, authenticateRequest, revokeSession } = await import("./session-store");
    const a = await issueSession(WALLET);
    const b = await issueSession(WALLET);
    await revokeSession(a.session);
    await revokeSession(a.session);
    expect(await authenticateRequest(requestWith(a.value))).toBeNull();
    expect(await authenticateRequest(requestWith(b.value))).not.toBeNull();
  });

  it("a session record is bound to the wallet in the cookie (no cross-wallet reuse)", async () => {
    const { issueSession, authenticateRequest, sessionRecordKey } = await import("./session-store");
    const { value, session } = await issueSession(WALLET);
    // Attacker manages to overwrite the server record with their own wallet
    // (or a record collision). The signed cookie still says WALLET; the two
    // must agree or the session is rejected.
    redis.call(["SET", sessionRecordKey(session.sessionId), JSON.stringify({ wallet: OTHER.toLowerCase(), issuedAt: session.issuedAt })]);
    expect(await authenticateRequest(requestWith(value))).toBeNull();
  });

  it("the server record expires with the cookie (no orphaned records)", async () => {
    const { issueSession, sessionRecordKey } = await import("./session-store");
    const { session } = await issueSession(WALLET);
    const ttl = redis.call(["TTL", sessionRecordKey(session.sessionId)]) as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(8 * 60 * 60);
  });

  it("legacy cookie (valid HMAC, no server record) is treated as needing re-login, not an error", async () => {
    const { createSession } = await import("./session");
    const { authenticateRequest } = await import("./session-store");
    // Minted by the previous stateless code path: signature is fine but the
    // registry has never heard of it.
    const { value } = createSession(WALLET);
    await expect(authenticateRequest(requestWith(value))).resolves.toBeNull();
  });

  it("tampered / expired / missing cookies never touch Redis", async () => {
    const { issueSession, authenticateRequest } = await import("./session-store");
    const { value } = await issueSession(WALLET);
    const before = redis.log.length;
    expect(await authenticateRequest(requestWith(`${value}x`))).toBeNull();
    expect(await authenticateRequest(new Request("https://mpgrhub.xyz/api/xp"))).toBeNull();
    expect(redis.log.length).toBe(before);
  });

  it("fails closed when Redis is unavailable", async () => {
    const { issueSession, authenticateRequest } = await import("./session-store");
    const { value } = await issueSession(WALLET);
    redisAvailable = false;
    await expect(authenticateRequest(requestWith(value))).resolves.toBeNull();
  });

  it("issueSession fails loudly when the registry write fails (no half-issued session)", async () => {
    const { issueSession } = await import("./session-store");
    redisAvailable = false;
    await expect(issueSession(WALLET)).rejects.toThrow();
  });
});
