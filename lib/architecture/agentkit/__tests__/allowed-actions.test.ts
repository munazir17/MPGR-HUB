import { describe, expect, it } from "vitest";

import {
  AGENTKIT_DENIED_ACTIONS,
  AGENTKIT_READ_ACTIONS,
  canonicalizeAgentKitActionName,
  classifyAgentKitAction,
  isAllowedAgentKitAction,
  isDeniedAgentKitAction,
} from "../allowed-actions";

describe("AgentKit allowlist", () => {
  it("allows the documented read actions under both short and prefixed names", () => {
    for (const name of AGENTKIT_READ_ACTIONS) {
      expect(classifyAgentKitAction(name)).toBe("read");
      expect(isAllowedAgentKitAction(name)).toBe(true);
    }

    expect(classifyAgentKitAction("WalletActionProvider_get_wallet_details")).toBe(
      "read",
    );
    expect(
      classifyAgentKitAction("X402ActionProvider_make_http_request"),
    ).toBe("read");
    expect(
      classifyAgentKitAction("X402ActionProvider_discover_x402_services"),
    ).toBe("read");
    expect(
      classifyAgentKitAction("CustomActionProvider_mpgr_onchain_policy"),
    ).toBe("read");
  });

  it("denies write and auto-pay actions, including prefixed AgentKit 0.10.4 names", () => {
    for (const name of AGENTKIT_DENIED_ACTIONS) {
      expect(classifyAgentKitAction(name)).toBe("denied");
      expect(isDeniedAgentKitAction(name)).toBe(true);
      expect(isAllowedAgentKitAction(name)).toBe(false);
    }

    expect(
      classifyAgentKitAction("WalletActionProvider_native_transfer"),
    ).toBe("denied");
    expect(
      classifyAgentKitAction("X402ActionProvider_make_http_request_with_x402"),
    ).toBe("denied");
    expect(
      classifyAgentKitAction("X402ActionProvider_retry_http_request_with_x402"),
    ).toBe("denied");
  });

  it("treats unknown actions as unknown, not allowed", () => {
    expect(classifyAgentKitAction("erc20_transfer")).toBe("unknown");
    expect(isAllowedAgentKitAction("erc20_transfer")).toBe(false);
    expect(classifyAgentKitAction("something_invented")).toBe("unknown");
  });

  it("canonicalizes only known provider prefixes so mpgr_onchain_policy stays intact", () => {
    expect(canonicalizeAgentKitActionName("mpgr_onchain_policy")).toBe(
      "mpgr_onchain_policy",
    );
    expect(
      canonicalizeAgentKitActionName("CustomActionProvider_mpgr_onchain_policy"),
    ).toBe("mpgr_onchain_policy");
    expect(
      canonicalizeAgentKitActionName(
        "X402ActionProvider_make_http_request_with_x402",
      ),
    ).toBe("make_http_request_with_x402");
  });
});
