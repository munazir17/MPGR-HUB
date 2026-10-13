// lib/delegated/__tests__/rpc-bounds.test.ts
//
// Every Base MAINNET RPC on the delegated path is bounded (see
// lib/delegated/rpc-bounds.ts). The root cause of the tick that died before any
// transaction was an unbounded hang: a dead RPC cost ~40 s per call, so the
// tick was killed while EXECUTING. This file proves the bound with a REAL local
// HTTP server that accepts connections and never answers.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import {
  DELEGATED_MAINNET_RPC_BOUNDS,
  DELEGATED_MAINNET_RPC_RETRY_COUNT,
  DELEGATED_MAINNET_RPC_TIMEOUT_MS,
} from "@/lib/delegated/rpc-bounds";

const TARGET = "0x1111111111111111111111111111111111111111" as const;

describe("mainnet delegated RPC bounds (pinned)", () => {
  it("per-attempt timeout is at most 10 s and the retry cap is small", () => {
    expect(DELEGATED_MAINNET_RPC_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(DELEGATED_MAINNET_RPC_RETRY_COUNT).toBeLessThanOrEqual(1);
    expect(DELEGATED_MAINNET_RPC_BOUNDS).toEqual({
      timeoutMs: DELEGATED_MAINNET_RPC_TIMEOUT_MS,
      retryCount: DELEGATED_MAINNET_RPC_RETRY_COUNT,
    });
  });
});

describe("a dead mainnet RPC rejects instead of hanging", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    // Accepts the TCP connection and the request, and never responds.
    server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("the mainnet broadcaster's sendTransaction (estimate + send) rejects within the bound", async () => {
    vi.stubEnv("BASE_RPC_URL", url);
    vi.stubEnv("MPGR_MAINNET_BROADCASTER_PRIVATE_KEY", generatePrivateKey());
    try {
      const { createMainnetDelegatedBroadcaster } = await import("@/lib/delegated/delegated-broadcaster");
      // Short bound for the test; the production default is DELEGATED_MAINNET_RPC_BOUNDS.
      const { broadcast, address } = createMainnetDelegatedBroadcaster({ timeoutMs: 200, retryCount: 1 });
      expect(address).not.toBeNull();

      const started = Date.now();
      await expect(broadcast({ to: TARGET, data: "0x", chainId: 8453, value: 0n })).rejects.toThrow();
      // 2 attempts x 200 ms plus overhead — far below the pre-fix ~40 s.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the mainnet posture chain view rejects a read within the bound", async () => {
    vi.stubEnv("BASE_RPC_URL", url);
    try {
      const { mainnetDelegatedChainView } = await import("@/lib/delegated/delegated-broadcaster");
      const view = mainnetDelegatedChainView({ timeoutMs: 200, retryCount: 1 });
      const started = Date.now();
      await expect(view.getBytecode(TARGET)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
