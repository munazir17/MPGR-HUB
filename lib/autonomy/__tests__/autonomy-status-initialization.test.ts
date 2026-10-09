// lib/autonomy/__tests__/autonomy-status-initialization.test.ts
//
// REGRESSION SUITE — "Autonomous Runtime Null Configuration" root-cause fix.
//
// Incident: with MPGR_AUTONOMOUS_EXECUTION_ADAPTER=delegated-permit2-mainnet
// (and the executor / broadcaster / feature flags configured in Vercel
// Production), the public endpoint /api/agent/autonomy/config reported
//   { enabled: true, emergencyDisabled: false, productionGate: false,
//     delegated: { chainId: null, executor: null }, executionAvailable: false }
// even though the latest deployment was READY.
//
// Confirmed root cause (reproduced before the fix): the config route renders
// autonomyStatus(), which reads the adapter REGISTRY — but the registry is
// only populated by getAutonomySystem()/build(), which the config route never
// calls. On Vercel every route is its own serverless function with its own
// module state, so even a warm tick function cannot help the config function:
// on a cold config instance getAutonomousExecutionAdapter() throws
// "configured but not installed (server wiring missing)", and the status
// try/catch silently converted that into null/false. The environment was NOT
// the (only) problem: once the system was built, the very same env produced
// chainId 8453 + the pinned executor.
//
// The fix: one idempotent, synchronous, side-effect-free installation path
// (ensureAutonomousExecutionAdapterInstalled) shared by build() and the
// read-only status path, plus a status renderer that resolves the INSTALLED
// adapter once and fails closed (and loud, via a one-time server log) when
// the configured adapter cannot be resolved.
//
// Safety properties pinned here:
//   * the public response SCHEMA is byte-identical (same keys) — the values
//     become truthful, the shape does not change;
//   * executionAvailable stays false while AUTONOMOUS_PRODUCTION_ENABLED is
//     off (the mandated configuration) — availability is earned by posture,
//     never assumed from an env var;
//   * the status endpoint performs no signing, no approval, no transaction
//     construction, no broadcast — and with the gate off, not even an RPC
//     call (proven against a local HTTP sink that records every request);
//   * missing/invalid/mismatched adapters fail closed to an explicit
//     unavailable state, never a healthy-looking one.
//
// Everything runs against mocked/local infrastructure: a LuaRedis double for
// the store seam, a local HTTP sink (or a dead local port) for RPC, and
// test-only keys/addresses. NO REAL MAINNET TRANSACTION, SIGNATURE, APPROVAL
// OR RPC CALL IS EVER MADE — and AUTONOMOUS_PRODUCTION_ENABLED stays unset in
// every test except the gate-contract table, which only reads the flag.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { getAddress, type Hex } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

import { AUTONOMOUS_PRODUCTION_GATE_ENV, isAutonomousProductionEnabled } from "@/lib/autonomy/config";
import { DELEGATED_EXECUTOR_ADDRESS } from "@/lib/executor/delegated-executor";
import type { DelegatedExecutionAdapter } from "@/lib/autonomy/delegated-execution-adapter";
import type { AutonomousExecutionAdapter } from "@/lib/autonomy/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAINNET_ADAPTER_ID = "delegated-permit2-mainnet";
const SEPOLIA_ADAPTER_ID = "delegated-permit2-sepolia";

/** The operator's documented Production pin (a PUBLIC contract address). */
const PRODUCTION_MAINNET_EXECUTOR = getAddress("0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb");
/** A second, clearly-test pin (same convention as production-gate.test.ts). */
const TEST_MAINNET_EXECUTOR = getAddress("0x1111111111111111111111111111111111111111");
/** Test-only broadcaster key — deliberately NOT the canary key. */
const TEST_BROADCASTER_KEY = ("0x" + "5a".repeat(32)) as Hex;
/** Dead local port: any accidental RPC fails fast, offline, and hermetically. */
const DEAD_RPC_URL = "http://127.0.0.1:9";

const MANAGED_ENV = [
  "MPGR_AUTONOMOUS_AGENT_ENABLED",
  "MPGR_AUTONOMOUS_EMERGENCY_DISABLE",
  "MPGR_AUTONOMOUS_EXECUTION_ADAPTER",
  "MPGR_MAINNET_DELEGATED_EXECUTOR",
  "MPGR_MAINNET_BROADCASTER_PRIVATE_KEY",
  "MPGR_BROADCASTER_PRIVATE_KEY",
  AUTONOMOUS_PRODUCTION_GATE_ENV,
  "BASE_RPC_URL",
  "BASE_SEPOLIA_RPC_URL",
] as const;

let savedEnv: Record<string, string | undefined> = {};

/** The operator's Production configuration (values are test doubles). */
function configureMainnetAdapter(executor: string = TEST_MAINNET_EXECUTOR) {
  process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
  delete process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
  process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = MAINNET_ADAPTER_ID;
  process.env.MPGR_MAINNET_DELEGATED_EXECUTOR = executor;
  process.env.MPGR_MAINNET_BROADCASTER_PRIVATE_KEY = TEST_BROADCASTER_KEY;
  delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV]; // the gate stays OFF (mandated)
  process.env.BASE_RPC_URL = DEAD_RPC_URL;
  process.env.BASE_SEPOLIA_RPC_URL = DEAD_RPC_URL;
}

/** Fresh module graph == a cold serverless instance (registry + singleton reset). */
async function freshModules() {
  const autonomy = await import("@/lib/autonomy");
  const registry = await import("@/lib/autonomy/execution-adapter");
  return { autonomy, registry };
}

/** Local HTTP sink: records every request so "no RPC" is proven, not assumed. */
function startRpcSink(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url} ${body}`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "sink: not found" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

type StatusPayload = {
  enabled: boolean;
  emergencyDisabled: boolean;
  productionGate: boolean;
  executionAvailable: boolean;
  delegated: { chainId: number | null; executor: string | null; walletSigningSupported: boolean };
  limits: Record<string, unknown>;
};

/** The exact public schema — pinned so the fix cannot silently change it. */
const STATUS_KEYS = ["delegated", "emergencyDisabled", "enabled", "executionAvailable", "limits", "productionGate"];
const DELEGATED_KEYS = ["chainId", "executor", "walletSigningSupported"];

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
  for (const k of MANAGED_ENV) delete process.env[k];
  // Every test starts from a cold serverless instance: fresh module state.
  vi.resetModules();
});

afterEach(() => {
  for (const k of MANAGED_ENV) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Fresh module/server initialization with the valid Mainnet adapter
// ---------------------------------------------------------------------------

describe("cold-start initialization with the valid Mainnet adapter configured", () => {
  it("a cold instance installs the configured adapter on first status read and reports it", async () => {
    configureMainnetAdapter();
    const { autonomy, registry } = await freshModules();

    // Pre-condition: nothing is installed yet (this is the cold start that
    // used to render nulls).
    expect(registry.peekInstalledAutonomousExecutionAdapter()).toBeNull();

    const status = autonomy.autonomyStatus() as StatusPayload;

    // The configured adapter is now installed and reported truthfully.
    const installed = registry.peekInstalledAutonomousExecutionAdapter();
    expect(installed?.id).toBe(MAINNET_ADAPTER_ID);
    expect(registry.getAutonomousExecutionAdapter().id).toBe(MAINNET_ADAPTER_ID);
    expect(status.delegated.chainId).toBe(8453);
    expect(status.delegated.executor).toBe(TEST_MAINNET_EXECUTOR);
    expect(status.enabled).toBe(true);
    expect(status.emergencyDisabled).toBe(false);
    expect(status.productionGate).toBe(false);
    // The production gate is OFF (mandated): availability stays false, and the
    // refusal reason is the gate — not a wiring failure.
    expect(status.executionAvailable).toBe(false);
    expect((installed as DelegatedExecutionAdapter).checkStatic().reason).toBe("PRODUCTION_GATE_DISABLED");
  });

  it("the adapter is installed exactly once across repeated status reads", async () => {
    configureMainnetAdapter();
    const { autonomy, registry } = await freshModules();

    autonomy.autonomyStatus();
    const first = registry.peekInstalledAutonomousExecutionAdapter();
    expect(first).not.toBeNull();

    autonomy.autonomyStatus();
    autonomy.autonomyStatus();
    expect(registry.peekInstalledAutonomousExecutionAdapter()).toBe(first); // same instance, no duplicate
  });
});

// ---------------------------------------------------------------------------
// 2. The config endpoint reports the correct chain ID and exact executor
// ---------------------------------------------------------------------------

describe("GET /api/agent/autonomy/config (real route handler, cold instance)", () => {
  it("reports chain 8453 and the exact operator-pinned executor, schema unchanged", async () => {
    configureMainnetAdapter(PRODUCTION_MAINNET_EXECUTOR);
    const { GET } = await import("@/app/api/agent/autonomy/config/route");

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as StatusPayload;

    // Exact operator pin, verbatim (checksummed by the runtime).
    expect(body.delegated.chainId).toBe(8453);
    expect(body.delegated.executor).toBe(PRODUCTION_MAINNET_EXECUTOR);
    expect(body.enabled).toBe(true);
    expect(body.emergencyDisabled).toBe(false);
    expect(body.productionGate).toBe(false);
    expect(body.executionAvailable).toBe(false); // gate off => truthful

    // Backward compatibility: the public schema is byte-identical.
    expect(Object.keys(body).sort()).toEqual([...STATUS_KEYS].sort());
    expect(Object.keys(body.delegated).sort()).toEqual([...DELEGATED_KEYS].sort());

    // No secret material anywhere in the payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(serialized).not.toContain(TEST_BROADCASTER_KEY);
    expect(serialized.toLowerCase()).not.toContain("private");
  });

  it("a second cold instance (fresh modules) produces the identical payload", async () => {
    configureMainnetAdapter(PRODUCTION_MAINNET_EXECUTOR);
    const { GET } = await import("@/app/api/agent/autonomy/config/route");
    const first = (await (await GET()).json()) as StatusPayload;

    vi.resetModules(); // a brand-new serverless instance
    const { GET: GET2 } = await import("@/app/api/agent/autonomy/config/route");
    const second = (await (await GET2()).json()) as StatusPayload;

    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// 3. Missing adapter fails closed (no false availability)
// ---------------------------------------------------------------------------

describe("missing adapter fails closed", () => {
  it("env unset: the refusing default adapter, explicit unavailable state", async () => {
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    const { autonomy, registry } = await freshModules();

    const status = autonomy.autonomyStatus() as StatusPayload;
    expect(registry.getAutonomousExecutionAdapter().id).toBe("none");
    expect(registry.delegatedExecutionAvailable()).toBe(false);
    expect(status.executionAvailable).toBe(false);
    expect(status.delegated.chainId).toBeNull();
    expect(status.delegated.executor).toBeNull();
    expect(Object.keys(status).sort()).toEqual([...STATUS_KEYS].sort());
  });

  it('env "none": same explicit unavailable state', async () => {
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = "none";
    const { autonomy, registry } = await freshModules();

    const status = autonomy.autonomyStatus() as StatusPayload;
    expect(registry.getAutonomousExecutionAdapter().id).toBe("none");
    expect(status.executionAvailable).toBe(false);
    expect(status.delegated.chainId).toBeNull();
    expect(status.delegated.executor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid adapter ID fails closed
// ---------------------------------------------------------------------------

describe("invalid adapter ID fails closed", () => {
  it("an unknown id never resolves permissively and renders unavailable", async () => {
    configureMainnetAdapter();
    process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = "delegated-permit2-mainnet-typo";
    const { autonomy, registry } = await freshModules();

    expect(() => registry.getAutonomousExecutionAdapter()).toThrow(/Unknown autonomous execution adapter/);
    // Nothing was installed for the bogus id.
    expect(registry.peekInstalledAutonomousExecutionAdapter()).toBeNull();

    const status = autonomy.autonomyStatus() as StatusPayload; // must not throw
    expect(status.executionAvailable).toBe(false);
    expect(status.delegated.chainId).toBeNull();
    expect(status.delegated.executor).toBeNull();
    expect(status.enabled).toBe(true);
    expect(Object.keys(status).sort()).toEqual([...STATUS_KEYS].sort());
  });
});

// ---------------------------------------------------------------------------
// 5. Configured adapter ID vs installed adapter ID mismatch fails closed
// ---------------------------------------------------------------------------

describe("configured/installed adapter mismatch fails closed", () => {
  it("mainnet configured while a Sepolia adapter is installed: unavailable, no overwrite", async () => {
    configureMainnetAdapter();
    const { autonomy, registry } = await freshModules();

    // A permissive-looking Sepolia adapter is already installed (e.g. by a
    // test or a partial bootstrap) while the operator selected mainnet.
    const installedSepolia: AutonomousExecutionAdapter = {
      id: SEPOLIA_ADAPTER_ID,
      chainId: 84532,
      canDelegate: true, // deliberately permissive: status must STILL refuse
      checkAuthorization: () => ({ authorized: true }),
      executeSwap: async () => ({ ok: true, txHash: "0x" as Hex }),
    };
    registry.installAutonomousExecutionAdapter(installedSepolia);

    expect(() => registry.getAutonomousExecutionAdapter()).toThrow(/is configured but .* is installed|fail-closed/i);

    const status = autonomy.autonomyStatus() as StatusPayload; // must not throw
    expect(status.executionAvailable).toBe(false); // never trusts the mismatch
    expect(status.delegated.chainId).toBeNull();
    expect(status.delegated.executor).toBeNull();

    // The ensure path did NOT overwrite the installed adapter.
    expect(registry.peekInstalledAutonomousExecutionAdapter()?.id).toBe(SEPOLIA_ADAPTER_ID);
  });

  it("sepolia configured while a mainnet adapter is installed: same fail-closed shape", async () => {
    configureMainnetAdapter();
    process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = SEPOLIA_ADAPTER_ID;
    const { autonomy, registry } = await freshModules();

    const installedMainnet: AutonomousExecutionAdapter = {
      id: MAINNET_ADAPTER_ID,
      chainId: 8453,
      canDelegate: true,
      checkAuthorization: () => ({ authorized: true }),
      executeSwap: async () => ({ ok: true, txHash: "0x" as Hex }),
    };
    registry.installAutonomousExecutionAdapter(installedMainnet);

    const status = autonomy.autonomyStatus() as StatusPayload;
    expect(status.executionAvailable).toBe(false);
    expect(status.delegated.chainId).toBeNull();
    expect(status.delegated.executor).toBeNull();
    expect(registry.peekInstalledAutonomousExecutionAdapter()?.id).toBe(MAINNET_ADAPTER_ID);
  });
});

// ---------------------------------------------------------------------------
// 6. AUTONOMOUS_PRODUCTION_ENABLED gate contract (fail-closed, exact "true")
// ---------------------------------------------------------------------------

describe("the production gate contract (AUTONOMOUS_PRODUCTION_ENABLED)", () => {
  const cases: Array<[string, string | undefined, boolean]> = [
    ["unset", undefined, false],
    ["empty", "", false],
    ['"false"', "false", false],
    ['"1"', "1", false],
    ['"TRUE" (case-insensitive true)', "TRUE", true],
    ['"True"', "True", true],
    ['exact "true"', "true", true],
    ['" true " (trimmed)', " true ", true],
  ];

  it.each(cases)("%s => gate %s", async (_label, value, expected) => {
    if (value === undefined) delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
    else process.env[AUTONOMOUS_PRODUCTION_GATE_ENV] = value;

    const { autonomy } = await freshModules();
    expect(isAutonomousProductionEnabled()).toBe(expected);
    expect((autonomy.autonomyStatus() as StatusPayload).productionGate).toBe(expected);
  });

  it("with the gate OFF, a fully-configured mainnet adapter still reports executionAvailable=false", async () => {
    configureMainnetAdapter();
    delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
    const { autonomy, registry } = await freshModules();

    const status = autonomy.autonomyStatus() as StatusPayload;
    const adapter = registry.getAutonomousExecutionAdapter() as DelegatedExecutionAdapter;
    expect(status.productionGate).toBe(false);
    expect(status.executionAvailable).toBe(false);
    expect(adapter.checkStatic().reason).toBe("PRODUCTION_GATE_DISABLED");
  });
});

// ---------------------------------------------------------------------------
// 7. Emergency disable overrides execution availability
// ---------------------------------------------------------------------------

describe("the emergency stop overrides execution availability", () => {
  it("with the Sepolia adapter installed, EMERGENCY_DISABLE refuses before posture", async () => {
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = SEPOLIA_ADAPTER_ID;
    process.env.MPGR_BROADCASTER_PRIVATE_KEY = TEST_BROADCASTER_KEY;
    process.env.BASE_SEPOLIA_RPC_URL = DEAD_RPC_URL;
    delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV]; // Sepolia is not gated
    const { autonomy, registry } = await freshModules();

    // Installed + operationally configured: cold posture => PENDING, not available.
    const status = autonomy.autonomyStatus() as StatusPayload;
    expect(status.delegated.chainId).toBe(84532);
    expect(status.delegated.executor).toBe(DELEGATED_EXECUTOR_ADDRESS);
    expect(status.executionAvailable).toBe(false);
    const adapter = registry.getAutonomousExecutionAdapter() as DelegatedExecutionAdapter;
    expect(adapter.checkStatic().reason).toBe("ONCHAIN_CHECK_PENDING");

    // Engage the kill switch: the very next status read refuses with
    // EMERGENCY_DISABLE — before any posture/verification — and stays false.
    process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE = "true";
    expect(adapter.checkStatic().reason).toBe("EMERGENCY_DISABLE");
    const stopped = autonomy.autonomyStatus() as StatusPayload;
    expect(stopped.emergencyDisabled).toBe(true);
    expect(stopped.executionAvailable).toBe(false);
    // The installed adapter is untouched (no reinstall, no state drift).
    expect(registry.peekInstalledAutonomousExecutionAdapter()).toBe(adapter);
  });
});

// ---------------------------------------------------------------------------
// 8. The config endpoint is read-only: no signing, approval, tx, broadcast, RPC
// ---------------------------------------------------------------------------

describe("the config endpoint performs no signing/approval/transaction/broadcast/RPC", () => {
  it("a fully-configured mainnet status read touches no gateway method and no RPC", async () => {
    const sink = await startRpcSink();
    try {
      configureMainnetAdapter(PRODUCTION_MAINNET_EXECUTOR);
      process.env.BASE_RPC_URL = sink.url; // any RPC would land here and be counted
      process.env.BASE_SEPOLIA_RPC_URL = sink.url;

      const { McpTradeGateway } = await import("@/lib/autonomy/mcp-gateway");
      const gatewaySpies = [
        vi.spyOn(McpTradeGateway.prototype, "quote"),
        vi.spyOn(McpTradeGateway.prototype, "prepare"),
        vi.spyOn(McpTradeGateway.prototype, "status"),
        vi.spyOn(McpTradeGateway.prototype, "verify"),
        vi.spyOn(McpTradeGateway.prototype, "delegateSwap"), // the ONLY broadcast path
        vi.spyOn(McpTradeGateway.prototype, "getCapabilities"),
      ];

      const { GET } = await import("@/app/api/agent/autonomy/config/route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = (await res.json()) as StatusPayload;
      expect(body.delegated.chainId).toBe(8453);
      expect(body.delegated.executor).toBe(PRODUCTION_MAINNET_EXECUTOR);

      // Repeat reads stay read-only too.
      await GET();
      await GET();

      for (const spy of gatewaySpies) expect(spy).not.toHaveBeenCalled();
      expect(sink.requests).toEqual([]); // zero RPC calls, mainnet or otherwise
    } finally {
      await sink.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Cold-start / repeated initialization consistency, no duplicate install
// ---------------------------------------------------------------------------

describe("cold-start and repeated initialization stay consistent", () => {
  it("status-first ordering: repeated reads + a later system build share ONE adapter", async () => {
    configureMainnetAdapter();
    const { autonomy, registry } = await freshModules();

    const s1 = autonomy.autonomyStatus() as StatusPayload;
    const installed = registry.peekInstalledAutonomousExecutionAdapter();
    expect(installed?.id).toBe(MAINNET_ADAPTER_ID);

    const s2 = autonomy.autonomyStatus() as StatusPayload;
    expect(s2).toEqual(s1);
    expect(registry.peekInstalledAutonomousExecutionAdapter()).toBe(installed);

    // The tick-route path building the system afterwards must reuse the SAME
    // installed adapter — no second construction, no duplicate registration.
    const system = autonomy.getAutonomySystem();
    expect(system.delegatedAdapter?.id).toBe(MAINNET_ADAPTER_ID);
    expect(registry.peekInstalledAutonomousExecutionAdapter()).toBe(installed);
    expect(system.delegatedAdapter).toBe(installed);

    const s3 = autonomy.autonomyStatus() as StatusPayload;
    expect(s3).toEqual(s1);
  });

  it("build-first ordering: the system installs the adapter and status agrees", async () => {
    configureMainnetAdapter();
    const { autonomy, registry } = await freshModules();

    // The tick route's path runs first this time.
    const system = autonomy.getAutonomySystem();
    expect(system.delegatedAdapter?.id).toBe(MAINNET_ADAPTER_ID);
    const installed = registry.peekInstalledAutonomousExecutionAdapter();
    expect(installed).toBe(system.delegatedAdapter);

    const status = autonomy.autonomyStatus() as StatusPayload;
    expect(status.delegated.chainId).toBe(8453);
    expect(status.delegated.executor).toBe(TEST_MAINNET_EXECUTOR);
    expect(status.executionAvailable).toBe(false); // gate off
    expect(registry.peekInstalledAutonomousExecutionAdapter()).toBe(installed);
  });

  it("a registry cleared underneath a warm instance reinstalls on next read (self-healing, fail-closed)", async () => {
    configureMainnetAdapter();
    const { autonomy, registry } = await freshModules();

    autonomy.autonomyStatus();
    const first = registry.peekInstalledAutonomousExecutionAdapter();
    expect(first).not.toBeNull();

    // Simulate the module registry losing the installation (e.g. a test reset
    // or an exotic runtime): the next status read must not report a healthy
    // state from a stale closure — it reinstalls from env and stays truthful.
    registry.clearInstalledAutonomousExecutionAdapter();
    expect(registry.peekInstalledAutonomousExecutionAdapter()).toBeNull();

    const status = autonomy.autonomyStatus() as StatusPayload;
    expect(status.delegated.chainId).toBe(8453);
    expect(status.delegated.executor).toBe(TEST_MAINNET_EXECUTOR);
    expect(status.executionAvailable).toBe(false);
    expect(registry.peekInstalledAutonomousExecutionAdapter()?.id).toBe(MAINNET_ADAPTER_ID);
  });
});

// ---------------------------------------------------------------------------
// 10. Sepolia / default adapters remain backward-compatible
// ---------------------------------------------------------------------------

describe("existing Sepolia adapter and default behavior remain backward-compatible", () => {
  it("delegated-permit2-sepolia reports chain 84532 and the code-pinned executor", async () => {
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER = SEPOLIA_ADAPTER_ID;
    delete process.env[AUTONOMOUS_PRODUCTION_GATE_ENV];
    const { autonomy, registry } = await freshModules();

    const status = autonomy.autonomyStatus() as StatusPayload;
    expect(registry.getAutonomousExecutionAdapter().id).toBe(SEPOLIA_ADAPTER_ID);
    expect(status.delegated.chainId).toBe(84532);
    expect(status.delegated.executor).toBe(DELEGATED_EXECUTOR_ADDRESS);
    // No testnet broadcaster key configured => honestly unavailable.
    expect(status.executionAvailable).toBe(false);
    const adapter = registry.getAutonomousExecutionAdapter() as DelegatedExecutionAdapter;
    expect(adapter.checkStatic().reason).toBe("BROADCASTER_NOT_CONFIGURED");
    expect(Object.keys(status).sort()).toEqual([...STATUS_KEYS].sort());
    expect(Object.keys(status.delegated).sort()).toEqual([...DELEGATED_KEYS].sort());
  });

  it("the disabled runtime still reports enabled=false with the same schema", async () => {
    // No autonomy env at all — the shipped default.
    const { autonomy } = await freshModules();
    const status = autonomy.autonomyStatus() as StatusPayload;
    expect(status.enabled).toBe(false);
    expect(status.emergencyDisabled).toBe(false);
    expect(status.productionGate).toBe(false);
    expect(status.executionAvailable).toBe(false);
    expect(status.delegated.chainId).toBeNull();
    expect(status.delegated.executor).toBeNull();
    expect(Object.keys(status).sort()).toEqual([...STATUS_KEYS].sort());
  });
});
