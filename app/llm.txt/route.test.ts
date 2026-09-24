import { describe, expect, it } from "vitest";

import { buildLlmTxt } from "@/lib/mcp/llm-txt";
import { MCP_TOOLS } from "@/lib/mcp/mcp-tools";
import { SEPOLIA_DEPLOYMENT, TEST_REGISTRY } from "@/lib/mcp/__tests__/fixtures";

import { GET } from "./route";
import { GET as GET_ALIAS } from "../llms.txt/route";

describe("/llm.txt", () => {
  it("is plain text describing the MCP endpoint, every tool, the flow and the exact fee", async () => {
    const res = GET();
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("/api/mcp");
    for (const t of MCP_TOOLS) expect(text).toContain(t.name);
    expect(text).toContain("floor(sellAmount * 25 / 10000)");
    expect(text).toMatch(/never sign/i);
    expect(await GET_ALIAS().text()).toBe(text);
  });

  it("lists a deployed executor from the registry", () => {
    const text = buildLlmTxt(TEST_REGISTRY);
    expect(text).toContain(SEPOLIA_DEPLOYMENT.executor);
    expect(text).toContain("tUSD");
  });

  it("never contains secrets, even when they are present in the environment", async () => {
    const planted: Record<string, string> = {
      AUTH_SESSION_SECRET: "planted-auth-secret-value-0123456789abcdef",
      ZERO_EX_API_KEY: "planted-0x-api-key",
      CDP_API_KEY_SECRET: "planted-cdp-secret",
      BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY: "0x" + "9".repeat(64),
      BASE_RPC_URL: "https://planted-rpc.example/v2/key123",
    };
    const prev = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    try {
      const text = await GET().text();
      for (const v of Object.values(planted)) expect(text).not.toContain(v);
      expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/); // no private-key-shaped values
      expect(text).not.toMatch(/api[-_]?key\s*[:=]/i);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
