import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildSiweMessage, siweSignatureVerifier, type AuthMessage } from "@/lib/auth/siwe";

const isNonceActive = vi.fn();
const consumeNonce = vi.fn();
const logApi = vi.fn();

vi.mock("@/lib/auth/nonce", () => ({
  isNonceActive: (...args: unknown[]) => isNonceActive(...args),
  consumeNonce: (...args: unknown[]) => consumeNonce(...args),
}));

vi.mock("@/lib/observability/log", () => ({
  logApi: (...args: unknown[]) => logApi(...args),
}));

vi.mock("@/lib/api/request-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/request-guard")>();
  return {
    ...actual,
    enforceRateLimit: async () => null,
    assertJsonBodyLimit: async () => null,
  };
});

const APP_ORIGIN = "https://mpgrhub.xyz";
const NONCE = "test-nonce-abc";
const SECRET = "a".repeat(32);

function validTimes() {
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return { issuedAt, expirationTime };
}

async function signedBody(overrides: Partial<AuthMessage> = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const expected: AuthMessage = {
    domain: "mpgrhub.xyz",
    address: account.address,
    uri: APP_ORIGIN,
    nonce: NONCE,
    chainId: 8453,
    ...validTimes(),
    ...overrides,
  };
  const message = buildSiweMessage(expected);
  const signature = await account.signMessage({ message });
  return { account, expected, message, signature, address: account.address };
}

function postVerify(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${APP_ORIGIN}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    vi.stubEnv("NODE_ENV", "production");
    isNonceActive.mockResolvedValue(true);
    consumeNonce.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("logs missing_nonce and returns 401 when the nonce cookie is absent", async () => {
    const { POST } = await import("./route");
    const { address, message, signature } = await signedBody();
    const response = await POST(postVerify({ address, message, signature }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Missing authentication nonce" });
    expect(logApi).toHaveBeenCalledWith(
      "warn",
      "auth_verify_failed",
      expect.objectContaining({
        auth_verify_failed_stage: "missing_nonce",
        cookieHeaderPresent: false,
      }),
    );
    expect(JSON.stringify(logApi.mock.calls)).not.toMatch(/0x[a-fA-F0-9]{64}/);
  });

  it("logs nonce_invalid and returns 401 when the nonce is expired or used", async () => {
    isNonceActive.mockResolvedValue(false);
    const { POST } = await import("./route");
    const { address, message, signature } = await signedBody();
    const response = await POST(
      postVerify({ address, message, signature }, { cookie: `mpgr_auth_nonce=${NONCE}` }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Nonce expired or already used" });
    expect(logApi).toHaveBeenCalledWith(
      "warn",
      "auth_verify_failed",
      expect.objectContaining({ auth_verify_failed_stage: "nonce_invalid" }),
    );
  });

  it("logs message_mismatch and returns 401 when the SIWE text is not canonical", async () => {
    const { POST } = await import("./route");
    const { address, message, signature } = await signedBody();
    const response = await POST(
      postVerify(
        { address, message: message.replace("mpgrhub.xyz", "evil.example"), signature },
        { cookie: `mpgr_auth_nonce=${NONCE}` },
      ),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid authentication message" });
    expect(logApi).toHaveBeenCalledWith(
      "warn",
      "auth_verify_failed",
      expect.objectContaining({
        auth_verify_failed_stage: "message_mismatch",
        expectedHost: "mpgrhub.xyz",
      }),
    );
    expect(JSON.stringify(logApi.mock.calls)).not.toContain(message);
  });

  it("logs signature_invalid and returns 401 for a bad signature", async () => {
    vi.spyOn(siweSignatureVerifier, "contract").mockResolvedValue(false);
    const { POST } = await import("./route");
    const { address, message } = await signedBody();
    const other = privateKeyToAccount(generatePrivateKey());
    const signature = await other.signMessage({ message });
    const response = await POST(
      postVerify({ address, message, signature }, { cookie: `mpgr_auth_nonce=${NONCE}` }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Wallet signature verification failed" });
    expect(logApi).toHaveBeenCalledWith(
      "warn",
      "auth_verify_failed",
      expect.objectContaining({ auth_verify_failed_stage: "signature_invalid" }),
    );
    expect(JSON.stringify(logApi.mock.calls)).not.toContain(signature);
    expect(JSON.stringify(logApi.mock.calls)).not.toContain(NONCE);
  });

  it("creates an mpgr_session after nonce + canonical message + valid EOA signature", async () => {
    const { POST } = await import("./route");
    const { address, message, signature } = await signedBody();
    const response = await POST(
      postVerify({ address, message, signature }, { cookie: `mpgr_auth_nonce=${NONCE}` }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { authenticated: boolean; wallet: string };
    expect(data.authenticated).toBe(true);
    expect(data.wallet).toBe(address.toLowerCase());
    expect(isNonceActive).toHaveBeenCalledWith(NONCE);
    expect(consumeNonce).toHaveBeenCalledWith(NONCE);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("mpgr_session=");
    expect(logApi).toHaveBeenCalledWith(
      "info",
      "wallet_session_created",
      expect.objectContaining({ wallet: address.toLowerCase() }),
    );
    expect(logApi.mock.calls.some((call) => call[1] === "auth_verify_failed")).toBe(false);
  });
});
