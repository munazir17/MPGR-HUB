import { describe, expect, it } from "vitest";
import { shouldPollLiveReads } from "@/lib/chain/live-read-policy";

describe("shouldPollLiveReads", () => {
  it("keeps the historical default of polling when callers pass nothing", () => {
    expect(shouldPollLiveReads()).toBe(true);
    expect(shouldPollLiveReads({})).toBe(true);
    expect(shouldPollLiveReads({ poll: true })).toBe(true);
  });

  it("allows an explicit one-shot reader to opt out", () => {
    expect(shouldPollLiveReads({ poll: false })).toBe(false);
  });
});
