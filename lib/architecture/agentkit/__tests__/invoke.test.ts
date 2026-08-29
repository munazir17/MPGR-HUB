import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PREPARE_ONLY_ERROR } from "../config";
import {
  invokeAgentKitAction,
  stripSecretsFromPayload,
} from "../invoke";

describe("invokeAgentKitAction allowlist gate", () => {
  it("denies native_transfer before AgentKit can sign", async () => {
    const result = await invokeAgentKitAction({
      actionName: "native_transfer",
      args: {
        to: "0x1111111111111111111111111111111111111111",
        value: "0.001",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ACTION_DENIED");
      expect(result.error).toBe(PREPARE_ONLY_ERROR);
    }
  });

  it("denies make_http_request_with_x402 and the prefixed AgentKit name", async () => {
    const short = await invokeAgentKitAction({
      actionName: "make_http_request_with_x402",
      args: { url: "https://example.com" },
    });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.code).toBe("ACTION_DENIED");

    const prefixed = await invokeAgentKitAction({
      actionName: "X402ActionProvider_retry_http_request_with_x402",
      args: {
        url: "https://example.com",
        selectedPaymentOption: {
          scheme: "exact",
          network: "base",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
      },
    });
    expect(prefixed.ok).toBe(false);
    if (!prefixed.ok) expect(prefixed.code).toBe("ACTION_DENIED");
  });

  it("rejects unknown write-shaped actions", async () => {
    const result = await invokeAgentKitAction({
      actionName: "erc20_transfer",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTION_UNKNOWN");
  });

  it("rejects a missing actionName", async () => {
    const result = await invokeAgentKitAction({ actionName: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
  });

  it("rejects make_http_request to a private host before AgentKit fetch", async () => {
    const result = await invokeAgentKitAction({
      actionName: "X402ActionProvider_make_http_request",
      args: { url: "https://127.0.0.1/secret" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_INPUT");
    }
  });

  it("runs mpgr_onchain_policy through AgentKit and returns Base policy JSON", async () => {
    const result = await invokeAgentKitAction({
      actionName: "mpgr_onchain_policy",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actionName).toBe("mpgr_onchain_policy");
      const policy = result.result as {
        networkId: string;
        signing: string;
        autoPay: boolean;
      };
      expect(policy.networkId).toBe("base-mainnet");
      expect(policy.signing).toBe("user-wallet-only");
      expect(policy.autoPay).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/CDP_/i);
      expect(JSON.stringify(result)).not.toMatch(/privateKey/i);
    }
  });
});

describe("stripSecretsFromPayload", () => {
  it("drops CDP / private-key fields and leaves payment amounts intact", () => {
    const stripped = stripSecretsFromPayload({
      maxAmountRequired: "1000000",
      payTo: "0x1111111111111111111111111111111111111111",
      cdpApiKeyId: "should-not-leak",
      CDP_API_KEY_SECRET: "should-not-leak",
      privateKey: "0xabc",
      nested: { walletSecret: "nope", asset: "usdc" },
    }) as Record<string, unknown>;

    expect(stripped.maxAmountRequired).toBe("1000000");
    expect(stripped.payTo).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(stripped.cdpApiKeyId).toBeUndefined();
    expect(stripped.CDP_API_KEY_SECRET).toBeUndefined();
    expect(stripped.privateKey).toBeUndefined();
    expect((stripped.nested as Record<string, unknown>).asset).toBe("usdc");
    expect(
      (stripped.nested as Record<string, unknown>).walletSecret,
    ).toBeUndefined();
  });
});

describe("runtime source safety", () => {
  it("never passes CDP credentials into AgentKit.from", () => {
    const src = readFileSync(
      join(__dirname, "..", "runtime.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/cdpApiKeyId/);
    expect(src).not.toMatch(/cdpApiKeySecret/);
    expect(src).not.toMatch(/cdpWalletSecret/);
    expect(src).not.toMatch(/CDP_API_KEY/);
    expect(src).toMatch(/walletProvider/);
    expect(src).toMatch(/x402ActionProvider/);
  });

  it("does not leak CDP env values even when they are set", async () => {
    const previous = {
      id: process.env.CDP_API_KEY_ID,
      secret: process.env.CDP_API_KEY_SECRET,
      wallet: process.env.CDP_WALLET_SECRET,
    };

    process.env.CDP_API_KEY_ID = "leak-me-id";
    process.env.CDP_API_KEY_SECRET = "leak-me-secret";
    process.env.CDP_WALLET_SECRET = "leak-me-wallet";

    try {
      const result = await invokeAgentKitAction({
        actionName: "mpgr_onchain_policy",
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("leak-me-id");
      expect(serialized).not.toContain("leak-me-secret");
      expect(serialized).not.toContain("leak-me-wallet");
    } finally {
      if (previous.id === undefined) delete process.env.CDP_API_KEY_ID;
      else process.env.CDP_API_KEY_ID = previous.id;
      if (previous.secret === undefined) delete process.env.CDP_API_KEY_SECRET;
      else process.env.CDP_API_KEY_SECRET = previous.secret;
      if (previous.wallet === undefined) delete process.env.CDP_WALLET_SECRET;
      else process.env.CDP_WALLET_SECRET = previous.wallet;
    }
  });
});
