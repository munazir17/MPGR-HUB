import { afterEach, describe, expect, it, vi } from "vitest";

const { mockList } = vi.hoisted(() => ({
  mockList: vi.fn(),
}));

vi.mock("@/lib/architecture/agentkit", () => ({
  listAllowedAgentKitActions: (...args: unknown[]) => mockList(...args),
}));

describe("GET /api/agentkit/actions", () => {
  afterEach(() => {
    mockList.mockReset();
  });

  it("lists only the allowlisted Base read actions", async () => {
    mockList.mockResolvedValue([
      {
        name: "get_wallet_details",
        description: "wallet",
        mode: "read",
      },
      {
        name: "make_http_request",
        description: "http",
        mode: "read",
      },
    ]);

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.network).toBe("base-mainnet");
    expect(body.chainId).toBe(8453);
    expect(body.signing).toBe("user-wallet-only");
    expect(body.actions.map((action: { name: string }) => action.name)).toEqual(
      ["get_wallet_details", "make_http_request"],
    );
    expect(JSON.stringify(body)).not.toContain("native_transfer");
    expect(JSON.stringify(body)).not.toMatch(/CDP_/i);
  });
});
