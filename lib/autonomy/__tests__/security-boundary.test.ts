// Security boundary tests (spec §24 — Security).
//
//  1. The production adapter registry fails closed and can NEVER sign.
//  2. Autonomy modules never import wallet-signing machinery.
//  3. The runtime cannot bypass policy/authorization even if the adapter lies.
//  4. The store type model cannot hold key material; stored JSON never
//     contains secret-shaped fields.
//  5. The existing MCP tool surface is unchanged (execution interface intact).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getAutonomousExecutionAdapter, noDelegationAdapter, NO_DELEGATION_REASON } from "@/lib/autonomy/execution-adapter";
import { makePolicy, WALLET } from "./helpers";
import { MCP_TOOLS } from "@/lib/mcp/mcp-tools";

describe("authorization boundary (spec §6)", () => {
  it("the default adapter refuses every authorization and every execution", async () => {
    expect(noDelegationAdapter.canDelegate).toBe(false);
    expect(noDelegationAdapter.checkAuthorization(WALLET, makePolicy())).toEqual({ authorized: false, reason: NO_DELEGATION_REASON });
    const result = await noDelegationAdapter.executeSwap({
      goalId: "g", policyId: "p", wallet: WALLET, chainId: 8453, quoteId: "q",
      sellToken: makePolicy().sellToken, buyToken: makePolicy().buyToken,
      sellAmountRaw: "1", expectedBuyAmountRaw: "1", minBuyAmountRaw: "1",
      slippageBps: 100, idempotencyKey: "k", steps: [], transactionRequest: null,
    });
    expect(result).toMatchObject({ ok: false, code: "AUTHORIZATION_MISSING" });
  });

  it("the adapter registry fails closed on unknown adapter ids", () => {
    const prev = process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER;
    try {
      process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = "supercustodial-nightmode";
      expect(() => getAutonomousExecutionAdapter()).toThrow(/fail-closed|Unknown autonomous execution adapter/i);
      process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = "";
      expect(getAutonomousExecutionAdapter().canDelegate).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER;
      else process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = prev;
    }
  });
});

describe("source boundary: autonomy never imports signing machinery", () => {
  const root = join(process.cwd(), "lib", "autonomy");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
    }
  })(root);

  it("scans every production autonomy module", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it("no autonomy module imports wagmi actions, viem wallets, or key material sources", () => {
    const forbidden = [
      /from\s+"wagmi\/actions"/,
      /from\s+"@\/lib\/wagmi"/,
      /signTransaction|signTypedData\(|signMessage\(/,
      /PRIVATE_KEY|privateKey\s*[:=]/,
      /generatePrivateKey|mnemonic|seedPhrase/i,
      /createWalletClient|generateMnemonic/,
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect({ file, pattern: String(pattern), match: pattern.test(src) }).toEqual({ file, pattern: String(pattern), match: false });
      }
    }
  });

  it("runtime modules never touch the executor ABI/encode path directly (MCP is the interface)", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (file.includes("__tests__")) continue;
      expect({ file, importsAbi: /mpgr-executor-abi/.test(src) }).toEqual({ file, importsAbi: false });
      expect({ file, importsEncode: /encodeFunctionData|encodeExecutorSwap/.test(src) }).toEqual({ file, importsEncode: false });
    }
  });
});

describe("execution interface intact (spec §1/§12)", () => {
  it("the canonical 7 MCP tools are unchanged and none signs", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      "mpgr_get_capabilities",
      "mpgr_list_tokens",
      "mpgr_get_quote",
      "mpgr_prepare_trade",
      "mpgr_finalize_trade",
      "mpgr_get_trade_status",
      "mpgr_verify_trade",
    ]);
    for (const tool of MCP_TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });
});
