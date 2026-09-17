import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionFromRequest = vi.fn<() => { wallet: string } | null>();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));

vi.mock("@/lib/api/request-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/request-guard")>();
  return {
    ...actual,
    enforceRateLimit: vi.fn().mockResolvedValue(null),
  };
});

const getAgentVisitorCount = vi.fn(async () => 1247);
const recordAgentVisitor = vi.fn(async () => 1247);
vi.mock("@/lib/agent/agent-visitor-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/agent-visitor-store")>();
  return {
    ...actual,
    getAgentVisitorCount,
    recordAgentVisitor,
  };
});

const APP_ORIGIN = "https://mpgrhub.xyz";

describe("GET/POST /api/agent/visitors", () => {
  let savedAppOrigin: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedAppOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = APP_ORIGIN;
    getSessionFromRequest.mockReturnValue(null);
    getAgentVisitorCount.mockResolvedValue(1247);
    recordAgentVisitor.mockResolvedValue(1247);
  });

  afterEach(() => {
    if (savedAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedAppOrigin;
  });

  it("returns the cumulative count without visitor identifiers", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request(`${APP_ORIGIN}/api/agent/visitors`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ count: 1247 });
    expect(JSON.stringify(body)).not.toMatch(/0x|wallet|visitor/i);
  });

  it("records a visitor once per identity and does not expose the id", async () => {
    const { POST } = await import("./route");
    const request = new Request(`${APP_ORIGIN}/api/agent/visitors`, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ count: 1247 });
    expect(recordAgentVisitor).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toMatch(/nvidia|gemini|0x/i);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/mpgr_agent_visitor=/);
    expect(setCookie).toMatch(/HttpOnly/i);
  });
});
