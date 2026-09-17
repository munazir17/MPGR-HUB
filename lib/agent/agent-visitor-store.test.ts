import { beforeEach, describe, expect, it, vi } from "vitest";

const members = new Set<string>();
const sadd = vi.fn(async (_key: string, member: string) => {
  const before = members.size;
  members.add(member);
  return members.size > before ? 1 : 0;
});
const scard = vi.fn(async () => members.size);

vi.mock("@/lib/api/redis", () => ({
  getRedis: () => ({ sadd, scard }),
}));

import { formatAgentUserCount } from "./format-agent-user-count";
import { getAgentVisitorCount, hashAgentVisitorId, recordAgentVisitor } from "./agent-visitor-store";

describe("agent visitor store", () => {
  beforeEach(() => {
    members.clear();
    sadd.mockClear();
    scard.mockClear();
  });

  it("increments once for a new visitor and ignores duplicate visits", async () => {
    expect(await recordAgentVisitor("anon:visitor-a")).toBe(1);
    expect(await recordAgentVisitor("anon:visitor-a")).toBe(1);
    expect(await recordAgentVisitor("wallet:0xd57b0000000000000000000000000000000095f7")).toBe(2);
    expect(await getAgentVisitorCount()).toBe(2);
    expect(sadd.mock.calls[0]?.[1]).toBe(hashAgentVisitorId("anon:visitor-a"));
    expect(sadd.mock.calls[0]?.[1]).not.toMatch(/0xd57b|visitor-a/i);
  });

  it("formats the cumulative count for the Agent status line", () => {
    expect(formatAgentUserCount(1247)).toBe("1,247");
    expect(formatAgentUserCount(12400)).toBe("12.4K");
    expect(formatAgentUserCount(1_200_000)).toBe("1.2M");
  });
});
