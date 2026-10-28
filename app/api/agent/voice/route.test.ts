import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getSessionFromRequest = vi.fn<() => { wallet: string } | null>();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));
vi.mock("@/lib/auth/session-store", () => ({
  authenticateRequest: async () => getSessionFromRequest(),
}));

vi.mock("@/lib/api/request-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/request-guard")>();
  return {
    ...actual,
    enforceRateLimit: vi.fn().mockResolvedValue(null),
  };
});

const APP_ORIGIN = "https://mpgrhub.xyz";
const FAKE_KEY = "test-nvidia-key-not-for-production";

function postVoice(headers: Record<string, string>, audio?: Blob) {
  const body = new FormData();
  if (audio) body.set("audio", audio, "speech.webm");
  return new Request(`${APP_ORIGIN}/api/agent/voice`, {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/agent/voice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
    vi.stubEnv("NVIDIA_API_KEY", "");
    vi.stubEnv("NVIDIA_API_KEYS", "");
    getSessionFromRequest.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects a cross-origin request before auth", async () => {
    const { POST } = await import("./route");
    const response = await POST(postVoice({ origin: "https://evil.com" }, new Blob(["audio-bytes-aaaaaaaa"], { type: "audio/webm" })));
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const { POST } = await import("./route");
    const response = await POST(postVoice({ origin: APP_ORIGIN }, new Blob(["audio-bytes-aaaaaaaa"], { type: "audio/webm" })));
    expect(response.status).toBe(401);
  });

  it("returns 503 when NVIDIA speech is not configured and does not call NVIDIA", async () => {
    getSessionFromRequest.mockReturnValue({ wallet: "0xd57b0000000000000000000000000000000095f7" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");
    const response = await POST(postVoice({ origin: APP_ORIGIN }, new Blob(["audio-bytes-aaaaaaaa"], { type: "audio/webm" })));
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.code).toBe("VOICE_UNCONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toMatch(/Bearer |nvapi-/);
  });

  it("transcribes with Parakeet and never returns the key", async () => {
    vi.stubEnv("NVIDIA_API_KEY", FAKE_KEY);
    getSessionFromRequest.mockReturnValue({ wallet: "0xd57b0000000000000000000000000000000095f7" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "buy 10 USDC of AAPLc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");
    const audio = new Blob([new Uint8Array(120)], { type: "audio/webm" });
    const response = await POST(postVoice({ origin: APP_ORIGIN }, audio));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ transcript: "buy 10 USDC of AAPLc", model: "nvidia/parakeet-ctc-1.1b-asr" });
    expect(JSON.stringify(payload)).not.toContain(FAKE_KEY);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(String(calls[0]?.[0])).toBe("https://integrate.api.nvidia.com/v1/audio/transcriptions");
  });

  it("rejects an empty recording", async () => {
    vi.stubEnv("NVIDIA_API_KEY", FAKE_KEY);
    getSessionFromRequest.mockReturnValue({ wallet: "0xd57b0000000000000000000000000000000095f7" });
    const { POST } = await import("./route");
    const response = await POST(postVoice({ origin: APP_ORIGIN }));
    expect(response.status).toBe(400);
  });
});
