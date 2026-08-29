import { describe, expect, it } from "vitest";

import {
  AGENTKIT_CHAIN_ID,
  AGENTKIT_NETWORK,
  AGENTKIT_NETWORK_ID,
  AGENTKIT_PROTOCOL_FAMILY,
  AGENTKIT_VIEM_CHAIN,
} from "../config";

describe("AgentKit Base mainnet configuration", () => {
  it("is locked to Base mainnet chain 8453", () => {
    expect(AGENTKIT_NETWORK_ID).toBe("base-mainnet");
    expect(AGENTKIT_CHAIN_ID).toBe(8453);
    expect(AGENTKIT_PROTOCOL_FAMILY).toBe("evm");
    expect(AGENTKIT_NETWORK).toEqual({
      protocolFamily: "evm",
      networkId: "base-mainnet",
      chainId: "8453",
    });
    expect(AGENTKIT_VIEM_CHAIN.id).toBe(8453);
  });
});
