import { describe, expect, it } from "vitest";
import { CHAIN_ID } from "@/lib/chain/base";
import { legacyMemoryKey, memoryKey } from "./memory-keys";

describe("memory keys", () => {
  it("namespaces persisted memory by chain and lowercased wallet", () => {
    const key = memoryKey("user-memory", "0xABCDef0000000000000000000000000000000001");
    expect(key).toBe(`mpgr-hub:${CHAIN_ID}:user-memory:0xabcdef0000000000000000000000000000000001`);
  });

  it("keeps a legacy un-chained key for migration reads", () => {
    expect(legacyMemoryKey("agent", "0xAbC")).toBe("mpgr-hub:agent:0xabc");
  });
});
