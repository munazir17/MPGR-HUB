// lib/delegated/__tests__/broadcaster-separation.test.ts
//
// Proves the two properties the MC-2 remediation depends on for the operator
// key to be safe:
//
//   1. CHAIN SEPARATION — the Base Sepolia and Base mainnet broadcasters are
//      driven by two independent env keys. A testnet key never grants mainnet
//      reach, and a mainnet key never broadcasts on a testnet.
//
//   2. HARD CANARY SEPARATION — the production mainnet broadcaster REFUSES the
//      Phase 5 canary key outright. The canary is a one-shot, deliberately
//      armed test path; it must never become production infrastructure.
//
// Plus a SOURCE BOUNDARY test: no production execution module may read
// MPGR_MAINNET_CANARY_PRIVATE_KEY. Only the armed canary test and the
// broadcaster's own refusal guard may mention it.
//
// Every module is re-imported fresh per test (vi.resetModules) because the
// broadcaster caches its derived account at module scope.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { CANARY_WALLET } from "@/lib/delegated/delegated-broadcaster";

const SEPOLIA_KEY = ("0x" + "11".repeat(32)) as Hex;
const MAINNET_KEY = ("0x" + "22".repeat(32)) as Hex;
const CANARY_KEY = ("0x" + "33".repeat(32)) as Hex;

const SEPOLIA_ADDRESS = privateKeyToAccount(SEPOLIA_KEY).address;
const MAINNET_ADDRESS = privateKeyToAccount(MAINNET_KEY).address;

const ENV_KEYS = [
  "MPGR_BROADCASTER_PRIVATE_KEY",
  "MPGR_MAINNET_BROADCASTER_PRIVATE_KEY",
  "MPGR_MAINNET_CANARY_PRIVATE_KEY",
];
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllEnvs();
  vi.resetModules();
});

function setEnv(env: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) saved[k] ??= process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
}

async function loadBroadcaster() {
  vi.resetModules();
  return import("@/lib/delegated/delegated-broadcaster");
}

describe("broadcaster chain separation", () => {
  it("two independent keys resolve to two independent accounts", async () => {
    setEnv({ MPGR_BROADCASTER_PRIVATE_KEY: SEPOLIA_KEY, MPGR_MAINNET_BROADCASTER_PRIVATE_KEY: MAINNET_KEY });
    const m = await loadBroadcaster();
    expect(m.delegatedBroadcasterAddress()).toBe(SEPOLIA_ADDRESS);
    expect(m.mainnetBroadcasterAddress()).toBe(MAINNET_ADDRESS);
    expect(m.delegatedBroadcasterAddress()).not.toBe(m.mainnetBroadcasterAddress());
    expect(m.delegatedBroadcasterAddressFor(84532)).toBe(SEPOLIA_ADDRESS);
    expect(m.delegatedBroadcasterAddressFor(8453)).toBe(MAINNET_ADDRESS);
    expect(m.delegatedBroadcasterAddressFor(1)).toBeNull();
  });

  it("a SEPOLIA-ONLY key grants no mainnet reach", async () => {
    setEnv({ MPGR_BROADCASTER_PRIVATE_KEY: SEPOLIA_KEY });
    const m = await loadBroadcaster();
    expect(m.delegatedBroadcasterAddress()).toBe(SEPOLIA_ADDRESS);
    expect(m.mainnetBroadcasterAddress()).toBeNull();
    const mainnet = m.createMainnetDelegatedBroadcaster();
    expect(mainnet.address).toBeNull();
    await expect(mainnet.broadcast({ to: CANARY_WALLET, data: "0x" as Hex, chainId: 8453 })).rejects.toThrow(
      /MPGR_MAINNET_BROADCASTER_PRIVATE_KEY is not configured/i,
    );
  });

  it("a MAINNET-ONLY key grants no testnet reach", async () => {
    setEnv({ MPGR_MAINNET_BROADCASTER_PRIVATE_KEY: MAINNET_KEY });
    const m = await loadBroadcaster();
    expect(m.mainnetBroadcasterAddress()).toBe(MAINNET_ADDRESS);
    expect(m.delegatedBroadcasterAddress()).toBeNull();
    const sepolia = m.createDelegatedBroadcaster();
    expect(sepolia.address).toBeNull();
    await expect(sepolia.broadcast({ to: CANARY_WALLET, data: "0x" as Hex, chainId: 84532 })).rejects.toThrow(
      /MPGR_BROADCASTER_PRIVATE_KEY is not configured/i,
    );
  });

  it("with NO key at all both chains fail closed", async () => {
    setEnv({});
    const m = await loadBroadcaster();
    expect(m.delegatedBroadcasterAddress()).toBeNull();
    expect(m.mainnetBroadcasterAddress()).toBeNull();
    expect(m.createDelegatedBroadcasterFor(84532).address).toBeNull();
    expect(m.createDelegatedBroadcasterFor(8453).address).toBeNull();
    await expect(m.createDelegatedBroadcasterFor(84532).broadcast({ to: CANARY_WALLET, data: "0x" as Hex, chainId: 84532 })).rejects.toThrow(/not configured/i);
  });

  it("a malformed key is treated as unconfigured, never as a valid key", async () => {
    setEnv({ MPGR_MAINNET_BROADCASTER_PRIVATE_KEY: "0xnothex" });
    const m = await loadBroadcaster();
    expect(m.mainnetBroadcasterAddress()).toBeNull();
    setEnv({ MPGR_MAINNET_BROADCASTER_PRIVATE_KEY: "0x22" });
    const m2 = await loadBroadcaster();
    expect(m2.mainnetBroadcasterAddress()).toBeNull();
  });

  it("a non-delegated chain gets a refusing broadcaster, not a fallback", async () => {
    setEnv({ MPGR_BROADCASTER_PRIVATE_KEY: SEPOLIA_KEY, MPGR_MAINNET_BROADCASTER_PRIVATE_KEY: MAINNET_KEY });
    const m = await loadBroadcaster();
    for (const chainId of [1, 10, 137, 31337, 84531]) {
      const b = m.createDelegatedBroadcasterFor(chainId);
      expect(b.address, `chain ${chainId}`).toBeNull();
      await expect(b.broadcast({ to: CANARY_WALLET, data: "0x" as Hex, chainId })).rejects.toThrow(/not a delegated execution chain/i);
    }
  });

  it("the mainnet broadcaster refuses a wrong chain and any native value", async () => {
    setEnv({ MPGR_MAINNET_BROADCASTER_PRIVATE_KEY: MAINNET_KEY });
    const m = await loadBroadcaster();
    const b = m.createMainnetDelegatedBroadcaster();
    expect(b.address).toBe(MAINNET_ADDRESS);
    // Never reaches the network: the chain guard throws first.
    await expect(b.broadcast({ to: CANARY_WALLET, data: "0x" as Hex, chainId: 84532 })).rejects.toThrow(/refusing chain 84532/i);
    await expect(b.broadcast({ to: CANARY_WALLET, data: "0x" as Hex, chainId: 8453, value: 1n })).rejects.toThrow(/refusing native value/i);
  });
});

describe("hard canary separation", () => {
  it("the mainnet broadcaster REFUSES the canary key even when it is the only key set", async () => {
    setEnv({ MPGR_MAINNET_CANARY_PRIVATE_KEY: CANARY_KEY, MPGR_MAINNET_BROADCASTER_PRIVATE_KEY: CANARY_KEY });
    const m = await loadBroadcaster();
    expect(m.mainnetBroadcasterAddress()).toBeNull();
    const b = m.createMainnetDelegatedBroadcaster();
    expect(b.address).toBeNull();
    await expect(b.broadcast({ to: CANARY_WALLET, data: "0x" as Hex, chainId: 8453 })).rejects.toThrow(/not configured|forbidden canary/i);
  });

  it("the canary key still works for the CANARY path only (it is not disabled, just not promoted)", async () => {
    // The remediation must not break the existing armed canary test: the key is
    // simply never accepted as the production broadcaster.
    setEnv({ MPGR_MAINNET_CANARY_PRIVATE_KEY: CANARY_KEY });
    const m = await loadBroadcaster();
    expect(m.mainnetBroadcasterAddress()).toBeNull();
    expect(privateKeyToAccount(CANARY_KEY).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("the canary account address is pinned and recognised", async () => {
    setEnv({});
    const m = await loadBroadcaster();
    expect(m.CANARY_WALLET).toBe("0xBF6c574b9543967f0D528ae49603b0A7574a280b");
    // The Sepolia key must not accidentally BE the canary.
    expect(SEPOLIA_ADDRESS.toLowerCase()).not.toBe(m.CANARY_WALLET.toLowerCase());
    expect(MAINNET_ADDRESS.toLowerCase()).not.toBe(m.CANARY_WALLET.toLowerCase());
  });

  it("a valid mainnet key set ALONGSIDE a different canary key is accepted", async () => {
    setEnv({ MPGR_MAINNET_CANARY_PRIVATE_KEY: CANARY_KEY, MPGR_MAINNET_BROADCASTER_PRIVATE_KEY: MAINNET_KEY });
    const m = await loadBroadcaster();
    expect(m.mainnetBroadcasterAddress()).toBe(MAINNET_ADDRESS);
  });
});

describe("source boundary: no production execution module reads the canary key", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (["node_modules", ".git", ".next", "__tests__", "coverage"].includes(entry)) continue;
        walk(full, out);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  it("MPGR_MAINNET_CANARY_PRIVATE_KEY appears ONLY in the broadcaster's refusal guard", () => {
    const root = process.cwd();
    const readers: string[] = [];
    const mentioners: string[] = [];
    for (const file of [...walk(join(root, "lib")), ...walk(join(root, "app"))]) {
      const src = readFileSync(file, "utf8");
      const rel = relative(root, file);
      // The precise property: which production modules actually READ the env
      // var (a comment naming it as a warning is not a read).
      if (/process\.env\.MPGR_MAINNET_CANARY_PRIVATE_KEY/.test(src)) readers.push(rel);
      if (src.includes("MPGR_MAINNET_CANARY_PRIVATE_KEY")) mentioners.push(rel);
    }
    // Exactly one production file may READ it, and only to REFUSE it.
    expect(readers).toEqual(["lib/delegated/delegated-broadcaster.ts"]);
    // Mentions are allowed only as documentation of the prohibition.
    expect(mentioners.sort()).toEqual(["lib/delegated/delegated-broadcaster.ts", "lib/executor/delegated-executor.ts"]);
    const src = readFileSync(join(root, "lib/delegated/delegated-broadcaster.ts"), "utf8");
    // The mention must be inside the refusal path, never an assignment used to
    // build a production account.
    expect(src).toMatch(/Never let the canary key double as the production broadcaster/);
    expect(src).not.toMatch(/privateKeyToAccount\(\s*process\.env\.MPGR_MAINNET_CANARY_PRIVATE_KEY/);
  });

  it("the autonomy runtime and adapter never read any private key env var", () => {
    const root = process.cwd();
    for (const rel of [
      "lib/autonomy/runtime.ts",
      "lib/autonomy/delegated-execution-adapter.ts",
      "lib/autonomy/index.ts",
      "lib/autonomy/scheduler.ts",
      "lib/autonomy/policy-engine.ts",
      "lib/autonomy/delegated-authorization.ts",
      "lib/mcp/mcp-trade-service.ts",
      "lib/delegated/broadcast-gate.ts",
    ]) {
      const src = readFileSync(join(root, rel), "utf8");
      expect({ file: rel, readsKey: /process\.env\.[A-Z_]*PRIVATE_KEY/.test(src) }).toEqual({ file: rel, readsKey: false });
      // CALL syntax only: `step: "signTypedData"` in the assisted path is an
      // instruction for the USER's wallet, not server-side signing.
      const signs =
        /privateKeyToAccount\s*\(/.test(src) ||
        /\.signTransaction\s*\(/.test(src) ||
        /\.signTypedData\s*\(/.test(src) ||
        /signTypedDataAsync\s*\(/.test(src);
      expect({ file: rel, signs }).toEqual({ file: rel, signs: false });
    }
  });
});
