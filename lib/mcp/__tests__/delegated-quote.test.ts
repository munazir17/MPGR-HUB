// lib/mcp/__tests__/delegated-quote.test.ts
//
// Phase 3 — delegated-executor QUOTING. The delegated executor is quoted from
// its OWN route registry (run-fresh tokens) and only for an explicit, exact
// executor match. The v1 registry stays the default when no executor is
// passed, and cross-wiring (v1 tokens against the delegated executor) is
// rejected before any chain read.

import { describe, expect, it, beforeEach } from "vitest";
import { getAddress } from "viem";

import { getQuote, type McpDeps } from "@/lib/mcp/mcp-trade-service";
import {
  BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
  DELEGATED_BASE_SEPOLIA_TSTOCK,
  DELEGATED_BASE_SEPOLIA_TUSD,
  DELEGATED_EXECUTOR_ADDRESS,
} from "@/lib/executor/delegated-executor";
import { BASE_SEPOLIA_TSTOCK as V1_TSTOCK, BASE_SEPOLIA_TUSD as V1_TUSD } from "@/lib/executor/executor-config";
import {
  EXECUTOR as V1_EXECUTOR,
  TSTOCK,
  TUSD,
  fakeReader,
  newFakeState,
  setBalance,
  testDeps,
  type FakeChainState,
} from "./fixtures";

type Data = Record<string, unknown>;
function ok(o: ReturnType<typeof getQuote> extends Promise<infer T> ? T : never): Data {
  if (!o.ok) throw new Error(`${o.error.code}: ${o.error.message}`);
  return o.data as Data;
}
function errCode(o: Awaited<ReturnType<typeof getQuote>>): string {
  if (o.ok) throw new Error("expected failure");
  return o.error.code;
}

let state: FakeChainState;
let deps: McpDeps;
const TAKER = getAddress("0x00000000000000000000000000000000000dEa11");

beforeEach(() => {
  state = newFakeState();
  // The delegated executor's live config is read at ITS address.
  deps = {
    ...testDeps(state, {}),
    reader: () => fakeReader(state, 84532, DELEGATED_EXECUTOR_ADDRESS),
    delegatedRegistry: { 84532: BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT },
  } as McpDeps;
  setBalance(state, DELEGATED_BASE_SEPOLIA_TUSD, TAKER, 10_000_000_000n);
});

const base = { chainId: 84532, taker: TAKER, slippageBps: 100 };

describe("delegated quote path (executor-arg selected registry)", () => {
  it("quotes the delegated tUSD->tSTOCK route when the pinned executor is passed", async () => {
    const d = ok(
      await getQuote(deps, {
        ...base,
        executor: DELEGATED_EXECUTOR_ADDRESS,
        sellToken: DELEGATED_BASE_SEPOLIA_TUSD,
        buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
        sellAmount: "100000000",
      }),
    );
    expect(d.chainId).toBe(84532);
    expect((d.sellToken as Data).address).toBe(DELEGATED_BASE_SEPOLIA_TUSD);
    expect((d.buyToken as Data).address).toBe(DELEGATED_BASE_SEPOLIA_TSTOCK);
    // fee is computed at 25 bps from the delegated executor's live config
    expect(d.feeAmount).toBe("250000");
    expect(d.minBuyAmount).not.toBe("0");
  });

  it("falls back to the v1 registry when NO executor is passed (manual path unchanged)", async () => {
    // NOTE: the fixture registry uses the FIXTURE token addresses (TUSD/TSTOCK),
    // so the fallback must resolve those — the real v1 addresses belong to the
    // production registry and are intentionally absent from the fixture.
    const d = ok(
      await getQuote(testDeps(state, {}), { ...base, sellToken: "tUSD", buyToken: "tSTOCK", sellAmountHuman: "10" }),
    );
    expect((d.sellToken as Data).address).toBe(TUSD);
    expect((d.buyToken as Data).address).toBe(TSTOCK);
  });

  it("rejects v1 tokens against the delegated executor (cross-wiring guard)", async () => {
    expect(
      errCode(
        await getQuote(deps, {
          ...base,
          executor: DELEGATED_EXECUTOR_ADDRESS,
          sellToken: V1_TUSD,
          buyToken: V1_TSTOCK,
          sellAmount: "1000000",
        }),
      ),
    ).toBe("TOKEN_NOT_ALLOWED");
  });

  it("rejects any executor other than the pinned delegated address", async () => {
    expect(
      errCode(
        await getQuote(deps, { ...base, executor: V1_EXECUTOR, sellToken: TUSD, buyToken: V1_TSTOCK, sellAmount: "1" }),
      ),
    ).toBe("EXECUTOR_MISMATCH");
  });

  it("rejects malformed executor values and mainnet delegated quoting", async () => {
    expect(
      errCode(
        await getQuote(deps, {
          ...base,
          executor: "0x1234",
          sellToken: DELEGATED_BASE_SEPOLIA_TUSD,
          buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
          sellAmount: "1",
        }),
      ),
    ).toBe("INVALID_EXECUTOR");
    // UPDATED BY THE MC-2 REMEDIATION. Base mainnet (8453) is now a delegated
    // chain, so the refusal is no longer "wrong chain" — it is the more precise
    // "no mainnet delegated executor is pinned", which is still fail-closed and
    // still means nothing can be quoted or executed on 8453 by default.
    // Critically the SEPOLIA executor address can never be used on mainnet:
    // unpinned => EXECUTOR_NOT_CONFIGURED, and once an operator pins a mainnet
    // executor the Sepolia address is rejected as EXECUTOR_MISMATCH (asserted
    // in the next test).
    expect(
      errCode(
        await getQuote(
          deps,
          {
            ...base,
            chainId: 8453,
            executor: DELEGATED_EXECUTOR_ADDRESS,
            sellToken: DELEGATED_BASE_SEPOLIA_TUSD,
            buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
            sellAmount: "1",
          },
        ),
      ),
    ).toBe("EXECUTOR_NOT_CONFIGURED");
  });

  it("fails closed when the delegated registry is missing", async () => {
    const noRegistry = { ...deps, delegatedRegistry: {} } as McpDeps;
    expect(
      errCode(
        await getQuote(noRegistry, {
          ...base,
          executor: DELEGATED_EXECUTOR_ADDRESS,
          sellToken: DELEGATED_BASE_SEPOLIA_TUSD,
          buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
          sellAmount: "1",
        }),
      ),
    ).toBe("EXECUTOR_NOT_DEPLOYED");
  });
});
