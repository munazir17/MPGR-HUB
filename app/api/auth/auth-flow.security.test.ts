// Task 6 — end-to-end authentication flow against the REAL route handlers,
// nonce store, session store and Lua scripts (Redis is the in-memory
// double from lib/__tests__/helpers/lua-redis.ts; only the rate limiter is
// stubbed to keep the test deterministic).
//
// Covers: EOA sign-in, ERC-1271 fallback, nonce single-use / replay,
// cross-wallet message binding, logout revocation, legacy cookies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

vi.mock("@/lib/api/request-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/request-guard")>();
  return { ...actual, enforceRateLimit: async () => null, assertJsonBodyLimit: async () => null };
});

const APP_ORIGIN = "https://mpgrhub.xyz";
const SECRET = "b".repeat(32);

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieFrom(response: Response, name: string): string {
  const line = setCookies(response).find((c) => c.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).split(";")[0] : "";
}

async function getNonce() {
  const { GET } = await import("./nonce/route");
  const response = await GET(new Request(`${APP_ORIGIN}/api/auth/nonce`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { nonce: string; issuedAt: string; expirationTime: string; chainId: number; origin: string };
  return { body, cookie: cookieFrom(response, "mpgr_auth_nonce") };
}

function messageFor(address: string, n: { nonce: string; issuedAt: string; expirationTime: string; chainId: number; origin: string }) {
  return [
    `${new URL(n.origin).host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to MPGR HUB.",
    "",
    `URI: ${n.origin}`,
    "Version: 1",
    `Chain ID: ${n.chainId}`,
    `Nonce: ${n.nonce}`,
    `Issued At: ${n.issuedAt}`,
    `Expiration Time: ${n.expirationTime}`,
  ].join("\n");
}

async function postVerify(body: unknown, nonceCookie: string) {
  const { POST } = await import("./verify/route");
  return POST(
    new Request(`${APP_ORIGIN}/api/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `mpgr_auth_nonce=${nonceCookie}` },
      body: JSON.stringify(body),
    }),
  );
}

async function signIn(account = privateKeyToAccount(generatePrivateKey())) {
  const { body, cookie } = await getNonce();
  const message = messageFor(account.address, body);
  const signature = await account.signMessage({ message });
  const response = await postVerify({ address: account.address, message, signature }, cookie);
  return { account, response, nonce: body, nonceCookie: cookie, message, signature, sessionCookie: cookieFrom(response, "mpgr_session") };
}

async function whoAmI(sessionCookie: string) {
  const { GET } = await import("./session/route");
  const response = await GET(new Request(`${APP_ORIGIN}/api/auth/session`, { headers: { cookie: `mpgr_session=${sessionCookie}` } }));
  return (await response.json()) as { authenticated: boolean; wallet?: string };
}

describe("wallet authentication flow (real routes, Lua-backed Redis double)", () => {
  beforeEach(() => {
    redis.reset();
    vi.resetModules();
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("EOA: nonce → sign → verify mints a registered session; the nonce is single-use", async () => {
    const { account, response, sessionCookie, nonce, nonceCookie, message, signature } = await signIn();
    expect(response.status).toBe(200);
    expect(sessionCookie).not.toBe("");
    expect(await whoAmI(sessionCookie)).toEqual(expect.objectContaining({ authenticated: true, wallet: account.address.toLowerCase() }));

    // The nonce key is gone from Redis …
    expect(redis.call(["GET", `mpgrhub:auth:nonce:${nonce.nonce}`])).toBeNull();
    // … so replaying the exact same signed payload is rejected.
    const replay = await postVerify({ address: account.address, message, signature }, nonceCookie);
    expect(replay.status).toBe(401);
    expect(cookieFrom(replay, "mpgr_session")).toBe("");
  });

  it("concurrent verify with the same nonce yields exactly one session", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { body, cookie } = await getNonce();
    const message = messageFor(account.address, body);
    const signature = await account.signMessage({ message });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postVerify({ address: account.address, message, signature }, cookie)),
    );
    const ok = responses.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409 || r.status === 401)).toHaveLength(4);
    expect(redis.keys().filter((k) => k.startsWith("mpgrhub:auth:session:"))).toHaveLength(1);
  });

  it("a nonce issued to one browser cannot be used with a message signed for another wallet", async () => {
    const victim = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const { body, cookie } = await getNonce();
    const message = messageFor(victim.address, body);
    const signature = await attacker.signMessage({ message });
    const { siweSignatureVerifier } = await import("@/lib/auth/siwe");
    vi.spyOn(siweSignatureVerifier, "contract").mockResolvedValue(false);
    const response = await postVerify({ address: victim.address, message, signature }, cookie);
    expect(response.status).toBe(401);
    expect(cookieFrom(response, "mpgr_session")).toBe("");
    // A failed verification does not burn the nonce (the honest owner can still sign in) …
    expect(redis.call(["GET", `mpgrhub:auth:nonce:${body.nonce}`])).toBe("unused");
    // … and the claimed address in the body cannot differ from the signed message.
    const mismatched = await postVerify({ address: attacker.address, message, signature }, cookie);
    expect(mismatched.status).toBe(401);
  });

  it("ERC-1271 (Coinbase Smart Wallet / Base Account): falls back to onchain verification for the claimed address", async () => {
    const smartWallet = "0x1234567890abcdef1234567890abcdef12345678";
    const { siweSignatureVerifier } = await import("@/lib/auth/siwe");
    const contract = vi.spyOn(siweSignatureVerifier, "contract").mockResolvedValue(true);
    const { body, cookie } = await getNonce();
    const message = messageFor(smartWallet, body);
    const response = await postVerify({ address: smartWallet, message, signature: "0x" + "ab".repeat(100) }, cookie);
    expect(response.status).toBe(200);
    expect(contract).toHaveBeenCalledTimes(1);
    expect(contract.mock.calls[0]?.[0]).toBe(smartWallet);
    expect(contract.mock.calls[0]?.[1]).toBe(message);
    expect(await whoAmI(cookieFrom(response, "mpgr_session"))).toEqual(expect.objectContaining({ authenticated: true, wallet: smartWallet }));
  });

  it("ERC-1271 rejection does not authenticate and does not consume the nonce", async () => {
    const smartWallet = "0x1234567890abcdef1234567890abcdef12345678";
    const { siweSignatureVerifier } = await import("@/lib/auth/siwe");
    const contract = vi.spyOn(siweSignatureVerifier, "contract").mockResolvedValue(false);
    const { body, cookie } = await getNonce();
    const response = await postVerify({ address: smartWallet, message: messageFor(smartWallet, body), signature: "0x" + "ab".repeat(100) }, cookie);
    expect(response.status).toBe(401);
    expect(contract).toHaveBeenCalledTimes(1);
    expect(redis.call(["GET", `mpgrhub:auth:nonce:${body.nonce}`])).toBe("unused");
  });

  it("logout revokes the session server-side: the same cookie value is rejected afterwards", async () => {
    const { sessionCookie, account } = await signIn();
    expect((await whoAmI(sessionCookie)).authenticated).toBe(true);

    const { POST: logout } = await import("./logout/route");
    const response = await logout(new Request(`${APP_ORIGIN}/api/auth/logout`, { method: "POST", headers: { cookie: `mpgr_session=${sessionCookie}` } }));
    expect(response.status).toBe(200);
    expect(setCookies(response).some((c) => /^mpgr_session=;.*Max-Age=0/.test(c))).toBe(true);

    // The registry record is gone and a replayed (captured) cookie no longer works …
    expect(redis.keys().filter((k) => k.startsWith("mpgrhub:auth:session:"))).toHaveLength(0);
    expect((await whoAmI(sessionCookie)).authenticated).toBe(false);

    // … while the wallet can simply sign in again.
    const again = await signIn(account);
    expect(again.response.status).toBe(200);
    expect((await whoAmI(again.sessionCookie)).authenticated).toBe(true);
  });

  it("logout with a revoked/legacy/missing cookie is a harmless no-op", async () => {
    const { POST: logout } = await import("./logout/route");
    const { createSession } = await import("@/lib/auth/session");
    const legacy = createSession("0x1111111111111111111111111111111111111111").value;
    for (const cookie of [undefined, "garbage", legacy]) {
      const response = await logout(new Request(`${APP_ORIGIN}/api/auth/logout`, { method: "POST", headers: cookie ? { cookie: `mpgr_session=${cookie}` } : {} }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authenticated: false });
    }
  });

  it("a cookie minted by the previous stateless code (valid HMAC, no registry record) is treated as signed-out, never as an error", async () => {
    const { createSession } = await import("@/lib/auth/session");
    const legacy = createSession("0x1111111111111111111111111111111111111111").value;
    expect(await whoAmI(legacy)).toEqual({ authenticated: false });
  });

  it("session cookies from two wallets stay isolated (no cross-wallet reuse)", async () => {
    const a = await signIn();
    const b = await signIn();
    expect((await whoAmI(a.sessionCookie)).wallet).toBe(a.account.address.toLowerCase());
    expect((await whoAmI(b.sessionCookie)).wallet).toBe(b.account.address.toLowerCase());
    // Revoking A does not touch B.
    const { POST: logout } = await import("./logout/route");
    await logout(new Request(`${APP_ORIGIN}/api/auth/logout`, { method: "POST", headers: { cookie: `mpgr_session=${a.sessionCookie}` } }));
    expect((await whoAmI(a.sessionCookie)).authenticated).toBe(false);
    expect((await whoAmI(b.sessionCookie)).authenticated).toBe(true);
  });

  it("session and nonce cookies are HttpOnly, Secure, SameSite=None, host-only in production", async () => {
    const { response } = await signIn();
    const sessionLine = setCookies(response).find((c) => c.startsWith("mpgr_session=")) ?? "";
    expect(sessionLine).toMatch(/HttpOnly/i);
    expect(sessionLine).toMatch(/Secure/i);
    expect(sessionLine).toMatch(/SameSite=None/i);
    expect(sessionLine).toMatch(/Path=\//);
    expect(sessionLine).not.toMatch(/Domain=/i);
    const maxAge = Number(/Max-Age=(\d+)/.exec(sessionLine)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(8 * 60 * 60);
    const { GET } = await import("./nonce/route");
    const nonceLine = setCookies(await GET(new Request(`${APP_ORIGIN}/api/auth/nonce`))).find((c) => c.startsWith("mpgr_auth_nonce=")) ?? "";
    expect(nonceLine).toMatch(/HttpOnly/i);
    expect(nonceLine).toMatch(/Secure/i);
    expect(nonceLine).toMatch(/SameSite=None/i);
  });
});
