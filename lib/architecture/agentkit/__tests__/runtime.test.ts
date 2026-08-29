import { describe, expect, it } from "vitest";

import { canonicalizeAgentKitActionName } from "../allowed-actions";
import { listAllowedAgentKitActions } from "../invoke";
import { createMpgrAgentKit } from "../runtime";

describe("createMpgrAgentKit", () => {
  it("registers AgentKit read actions on Base and does not advertise writes through the allowlist", async () => {
    const kit = await createMpgrAgentKit();
    const names = kit.getActions().map((action) => action.name);
    const canonical = names.map(canonicalizeAgentKitActionName);

    expect(canonical).toContain("get_wallet_details");
    expect(canonical).toContain("make_http_request");
    expect(canonical).toContain("discover_x402_services");
    expect(canonical).toContain("mpgr_onchain_policy");

    // AgentKit still *has* write actions internally — MPGR must not
    // expose them through listAllowedAgentKitActions.
    expect(canonical).toContain("native_transfer");
    expect(canonical).toContain("make_http_request_with_x402");

    const allowed = await listAllowedAgentKitActions();
    const allowedNames = allowed.map((action) => action.name);

    expect(allowedNames).toEqual(
      expect.arrayContaining([
        "get_wallet_details",
        "make_http_request",
        "discover_x402_services",
        "mpgr_onchain_policy",
      ]),
    );
    expect(allowedNames).not.toContain("native_transfer");
    expect(allowedNames).not.toContain("make_http_request_with_x402");
    expect(allowedNames).not.toContain("retry_http_request_with_x402");
    expect(allowed.every((action) => action.mode === "read")).toBe(true);
  });

  it("returns the MPGR onchain policy without signing", async () => {
    const kit = await createMpgrAgentKit();
    const action = kit
      .getActions()
      .find(
        (item) =>
          canonicalizeAgentKitActionName(item.name) === "mpgr_onchain_policy",
      );

    expect(action).toBeDefined();
    const raw = await action!.invoke({});
    const parsed = JSON.parse(String(raw)) as {
      networkId: string;
      chainId: number;
      signing: string;
      autoPay: boolean;
      execute: boolean;
    };

    expect(parsed.networkId).toBe("base-mainnet");
    expect(parsed.chainId).toBe(8453);
    expect(parsed.signing).toBe("user-wallet-only");
    expect(parsed.autoPay).toBe(false);
    expect(parsed.execute).toBe(false);
  });
});
