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

  it("advertises the deployed Base mainnet executor, its proven route and the operator gate", () => {
    const text = buildLlmTxt(); // default = the production registry
    expect(text).toContain("0xD982726e28275661F8aB64054E6b17a70a63505A");
    expect(text).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(text).toContain("uniswap-v3 fee 3000");
    expect(text).toContain("MPGR_MCP_ENABLE_BASE_MAINNET=true");
    expect(text).not.toMatch(/chainId 8453[\s\S]{0,240}not deployed/);
  });

  it("never contains secrets, even when they are present in the environment", async () => {
    // Distinct marker values built at runtime (no secret-shaped literals in source).
    const mark = (tag: string) => ["planted", tag, "z".repeat(24)].join("-");
    const planted: Record<string, string> = {
      AUTH_SESSION_SECRET: mark("auth"),
      ZERO_EX_API_KEY: mark("zeroex"),
      CDP_API_KEY_SECRET: mark("cdp"),
      BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY: "0x" + "9".repeat(64),
      BASE_RPC_URL: `https://${mark("rpc")}.example/v2`,
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
