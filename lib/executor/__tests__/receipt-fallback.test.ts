// lib/executor/__tests__/receipt-fallback.test.ts
//
// LIVE-CANARY REGRESSION (offline, mocked — no network): base-rpc.publicnode
// rejected a normal recent-block eth_getTransactionReceipt with a JSON-RPC
// error body ("Archive requests require a personal token", code -32602).
// viem's transport-level fallback does NOT engage on JSON-RPC error bodies,
// so the successful autonomous canary crashed at receipt verification.
// These tests lock the application-level, receipt-only fallback:
// primary first, deterministic public-endpoint retries, fail-closed.

import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { readTransactionReceiptWithFallback, waitForTransactionReceiptWithFallback, type ChainReader } from "@/lib/executor/executor-chain";
import type { ReceiptLike } from "@/lib/executor/executor-verify";

const HASH = ("0x" + "ab".repeat(32)) as Hex;
const GOOD: ReceiptLike = { status: "success", transactionHash: HASH, blockNumber: 52_125_202n, from: "0x1" as never, to: "0x2" as never, logs: [] };

const archiveGateError = new Error('Archive requests require a personal token (code -32602)');

function factoryOf(results: Map<string, () => Promise<ReceiptLike>>) {
  return (url: string) => ({
    getTransactionReceipt: async () => {
      const fn = results.get(url);
      if (!fn) throw archiveGateError;
      return fn();
    },
  });
}

describe("readTransactionReceiptWithFallback (offline, mocked clients)", () => {
  it("primary success -> returned as-is, fallbacks never contacted", async () => {
    const contacted: string[] = [];
    const receipt = await readTransactionReceiptWithFallback(8453, HASH, async () => GOOD, {
      urls: ["https://a.example", "https://b.example"],
      clientFactory: (url: string) => { contacted.push(url); throw new Error("must not be called"); },
    }).catch((e) => { throw e; });
    expect(receipt).toEqual(GOOD);
    expect(contacted).toEqual([]);
  });

  it("primary archive-gated -> fallback serves the identical receipt", async () => {
    const calls: string[] = [];
    const receipt = await readTransactionReceiptWithFallback(8453, HASH, async () => { throw archiveGateError; }, {
      urls: ["https://a.example", "https://b.example"],
      clientFactory: (url) => { calls.push(url); return { getTransactionReceipt: async () => GOOD }; },
    });
    expect(calls).toEqual(["https://a.example"]); // stops at the FIRST working endpoint
    expect(receipt).toEqual(GOOD);
  });

  it("deterministic order: first working endpoint wins (second never called)", async () => {
    const calls: string[] = [];
    const receipt = await readTransactionReceiptWithFallback(8453, HASH, async () => { throw archiveGateError; }, {
      urls: ["https://a.example", "https://b.example"],
      clientFactory: (url) => { calls.push(url); if (url === "https://a.example") throw new Error("down"); return { getTransactionReceipt: async () => GOOD }; },
    });
    expect(calls).toEqual(["https://a.example", "https://b.example"]);
    expect(receipt.status).toBe("success");
  });

  it("fail-closed: every endpoint failing rethrows the ORIGINAL primary error", async () => {
    await expect(
      readTransactionReceiptWithFallback(8453, HASH, async () => { throw archiveGateError; }, {
        urls: ["https://a.example", "https://b.example"],
        clientFactory: () => ({ getTransactionReceipt: async () => { throw new Error("also down"); } }),
      }),
    ).rejects.toThrow(/Archive requests require a personal token/);
  });

  it("scope discipline: non-mainnet chains get NO fallback (original error rethrown)", async () => {
    const calls: string[] = [];
    await expect(
      readTransactionReceiptWithFallback(84532, HASH, async () => { throw archiveGateError; }, {
        urls: ["https://a.example"],
        clientFactory: (url) => { calls.push(url); return { getTransactionReceipt: async () => GOOD }; },
      }),
    ).rejects.toThrow(/Archive requests/);
    expect(calls).toEqual([]);
  });
});

describe("waitForTransactionReceiptWithFallback (offline, fake reader)", () => {
  const fastSleep = (ms = 0) => async () => { void ms; };

  it("not-yet-mined (not found) then mined -> returns the receipt", async () => {
    let attempts = 0;
    const reader: Pick<ChainReader, "getTransactionReceipt"> = {
      async getTransactionReceipt() {
        attempts += 1;
        if (attempts < 3) throw new Error("Transaction receipt with hash 0xab… could not be found.");
        return GOOD;
      },
    };
    const receipt = await waitForTransactionReceiptWithFallback(8453, HASH, reader, { timeoutMs: 10_000, intervalMs: 1, sleep: fastSleep() });
    expect(receipt).toEqual(GOOD);
    expect(attempts).toBe(3);
  });

  it("endpoint keeps erroring past the deadline -> throws the last error (no infinite wait)", async () => {
    const reader: Pick<ChainReader, "getTransactionReceipt"> = {
      async getTransactionReceipt() { throw archiveGateError; },
    };
    await expect(
      waitForTransactionReceiptWithFallback(8453, HASH, reader, { timeoutMs: 5, intervalMs: 1, sleep: fastSleep() }),
    ).rejects.toThrow(/Archive requests/);
  });

  it("immediately mined -> single read", async () => {
    let attempts = 0;
    const reader: Pick<ChainReader, "getTransactionReceipt"> = {
      async getTransactionReceipt() { attempts += 1; return GOOD; },
    };
    await waitForTransactionReceiptWithFallback(8453, HASH, reader, { timeoutMs: 10_000, intervalMs: 1, sleep: fastSleep() });
    expect(attempts).toBe(1);
  });
});
