import { describe, expect, it, vi } from "vitest";
const getRankedWallets = vi.fn(async () => []);
const getServerWalletStanding = vi.fn(async () => null);
const getRankedWalletCount = vi.fn(async () => 1);
vi.mock("@/lib/rewards/xp-ledger", () => ({ getRankedWallets, getServerWalletStanding, getRankedWalletCount }));
vi.mock("@/lib/referral/referral-store", () => ({ referralStore: { getReferralCount: vi.fn(async () => 0) } }));
describe("leaderboard trust boundary", () => {
  it("rejects direct browser writes", async () => {
    const { POST } = await import("./route");
    const response = await POST();
    expect(response.status).toBe(410);
  });
  it("reads from the server-owned XP ranking", async () => {
    getRankedWallets.mockResolvedValue([{ wallet: "0x0000000000000000000000000000000000000001", xp: 50, seasonPoints: 50 }]);
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/leaderboard"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.top[0].xp).toBe(50);
  });
});
