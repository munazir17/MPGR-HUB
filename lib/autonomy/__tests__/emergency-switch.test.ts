import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";

import {
  AUTONOMY_EMERGENCY_SWITCH_KEY,
  AUTONOMY_EMERGENCY_SWITCH_READ_TIMEOUT_MS,
  parseAutonomyEmergencySwitchRecord,
  readAutonomousEmergencySwitch,
  resetEmergencySwitchForTests,
  setEmergencySwitchKvForTests,
  setEmergencySwitchReaderForTests,
  type EmergencySwitchKv,
} from "@/lib/autonomy/emergency-switch";
import { isAutonomousExecutionEmergencyDisabled } from "@/lib/autonomy/config";

const ENABLED = {
  v: 1,
  enabled: true,
  updatedAt: "2026-10-10T00:00:00.000Z",
  updatedBy: "operator@example",
  note: "canary",
};

function memoryKv(store: Map<string, unknown>, opts: { delayMs?: number; error?: Error } = {}): EmergencySwitchKv {
  return {
    async get(key: string) {
      if (opts.error) throw opts.error;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return store.has(key) ? store.get(key)! : null;
    },
  };
}

describe("parseAutonomyEmergencySwitchRecord", () => {
  it("accepts an explicit enabled v1 record", () => {
    const parsed = parseAutonomyEmergencySwitchRecord(ENABLED);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.record.enabled).toBe(true);
  });

  it("accepts JSON strings (Upstash may return either)", () => {
    const parsed = parseAutonomyEmergencySwitchRecord(JSON.stringify(ENABLED));
    expect(parsed.ok).toBe(true);
  });

  it("refuses missing records", () => {
    expect(parseAutonomyEmergencySwitchRecord(null).ok).toBe(false);
    expect(parseAutonomyEmergencySwitchRecord(undefined).ok).toBe(false);
  });

  it("refuses missing fields", () => {
    expect(parseAutonomyEmergencySwitchRecord({ v: 1, enabled: true }).ok).toBe(false);
    expect(parseAutonomyEmergencySwitchRecord({ enabled: true, updatedAt: ENABLED.updatedAt }).ok).toBe(false);
  });

  it("refuses malformed and invalid records", () => {
    expect(parseAutonomyEmergencySwitchRecord("not-json").ok).toBe(false);
    expect(parseAutonomyEmergencySwitchRecord([]).ok).toBe(false);
    expect(parseAutonomyEmergencySwitchRecord({ v: 1, enabled: "true", updatedAt: ENABLED.updatedAt }).ok).toBe(false);
    expect(parseAutonomyEmergencySwitchRecord({ v: 1, enabled: true, updatedAt: "not-a-date" }).ok).toBe(false);
  });

  it("refuses unsupported versions", () => {
    const parsed = parseAutonomyEmergencySwitchRecord({ ...ENABLED, v: 2 });
    expect(parsed).toEqual({ ok: false, reason: "EMERGENCY_SWITCH_UNSUPPORTED_VERSION" });
  });
});

describe("readAutonomousEmergencySwitch fail-closed", () => {
  beforeEach(() => {
    resetEmergencySwitchForTests();
    vi.unstubAllEnvs();
    delete process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE;
  });
  afterEach(() => {
    resetEmergencySwitchForTests();
    vi.unstubAllEnvs();
  });

  it("allows only an explicit enabled record", async () => {
    const store = new Map<string, unknown>([[AUTONOMY_EMERGENCY_SWITCH_KEY, ENABLED]]);
    setEmergencySwitchKvForTests(memoryKv(store));
    const d = await readAutonomousEmergencySwitch("c1");
    expect(d).toMatchObject({ allowed: true, reason: "ENABLED", correlationId: "c1" });
  });

  it("refuses an explicit disabled record", async () => {
    setEmergencySwitchKvForTests(memoryKv(new Map([[AUTONOMY_EMERGENCY_SWITCH_KEY, { ...ENABLED, enabled: false }]])));
    const d = await readAutonomousEmergencySwitch();
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("EMERGENCY_SWITCH_DISABLED");
  });

  it("refuses a missing key", async () => {
    setEmergencySwitchKvForTests(memoryKv(new Map()));
    const d = await readAutonomousEmergencySwitch();
    expect(d.reason).toBe("EMERGENCY_SWITCH_MISSING");
    expect(d.allowed).toBe(false);
  });

  it("refuses malformed, unsupported-version, and invalid records", async () => {
    setEmergencySwitchKvForTests(memoryKv(new Map([[AUTONOMY_EMERGENCY_SWITCH_KEY, "nope"]])));
    expect((await readAutonomousEmergencySwitch()).reason).toBe("EMERGENCY_SWITCH_MALFORMED");

    setEmergencySwitchKvForTests(memoryKv(new Map([[AUTONOMY_EMERGENCY_SWITCH_KEY, { ...ENABLED, v: 99 }]])));
    expect((await readAutonomousEmergencySwitch()).reason).toBe("EMERGENCY_SWITCH_UNSUPPORTED_VERSION");

    setEmergencySwitchKvForTests(memoryKv(new Map([[AUTONOMY_EMERGENCY_SWITCH_KEY, { ...ENABLED, enabled: "yes" }]])));
    expect((await readAutonomousEmergencySwitch()).reason).toBe("EMERGENCY_SWITCH_INVALID");
  });

  it("refuses on KV timeout", async () => {
    setEmergencySwitchKvForTests(memoryKv(new Map(), { delayMs: AUTONOMY_EMERGENCY_SWITCH_READ_TIMEOUT_MS + 200 }));
    const d = await readAutonomousEmergencySwitch();
    expect(d.reason).toBe("EMERGENCY_SWITCH_TIMEOUT");
    expect(d.allowed).toBe(false);
  });

  it("refuses on network / KV error", async () => {
    setEmergencySwitchKvForTests(memoryKv(new Map(), { error: new Error("ECONNRESET") }));
    const d = await readAutonomousEmergencySwitch();
    expect(d.reason).toBe("EMERGENCY_SWITCH_ERROR");
  });

  it("refuses when KV is unavailable", async () => {
    setEmergencySwitchKvForTests(null);
    const d = await readAutonomousEmergencySwitch();
    expect(d.reason).toBe("EMERGENCY_SWITCH_UNAVAILABLE");
  });

  it("env flag enabled cannot override missing or disabled KV", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_EMERGENCY_DISABLE", "false");
    setEmergencySwitchKvForTests(null);
    expect((await readAutonomousEmergencySwitch()).allowed).toBe(false);

    setEmergencySwitchKvForTests(memoryKv(new Map([[AUTONOMY_EMERGENCY_SWITCH_KEY, { ...ENABLED, enabled: false }]])));
    expect((await readAutonomousEmergencySwitch()).allowed).toBe(false);
  });

  it("env emergency disable further restricts even when KV is enabled", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_EMERGENCY_DISABLE", "true");
    expect(isAutonomousExecutionEmergencyDisabled()).toBe(true);
    setEmergencySwitchKvForTests(memoryKv(new Map([[AUTONOMY_EMERGENCY_SWITCH_KEY, ENABLED]])));
    const d = await readAutonomousEmergencySwitch();
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("ENV_EMERGENCY_DISABLE");
  });

  it("uses the real @upstash/redis client against a fake REST requester", async () => {
    const request = vi.fn(async () => ({ result: ENABLED as unknown }));
    const redis = new Redis({ request: request as never });
    setEmergencySwitchKvForTests(redis);
    const d = await readAutonomousEmergencySwitch("upstash");
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("ENABLED");
    expect(request).toHaveBeenCalled();
  });
});
