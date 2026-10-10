// lib/autonomy/emergency-switch.ts
//
// Authoritative, fail-closed KV control for autonomous EXECUTION.
//
// Key: mpgrhub:autonomy:switch
// Freshness: uncached GET at the execution boundary (no application cache).
// Authorization to WRITE is out-of-band (Upstash console / Redis ACL) — this
// module never exposes a public write endpoint.
//
// Semantics: execution is allowed ONLY when an explicit, well-formed record
// with version 1 and enabled === true is read successfully. Missing key,
// missing fields, malformed JSON, unsupported version, unexpected values,
// timeout, network error, or unavailable KV => refuse.
//
// Environment flag MPGR_AUTONOMOUS_EMERGENCY_DISABLE may FURTHER restrict
// execution but NEVER enables it when KV is missing, disabled, or unreadable.

import { randomUUID } from "node:crypto";

import { getRedis } from "@/lib/api/redis";

import { isAutonomousExecutionEmergencyDisabled } from "./config";

export const AUTONOMY_EMERGENCY_SWITCH_KEY = "mpgrhub:autonomy:switch";
export const AUTONOMY_EMERGENCY_SWITCH_SCHEMA_VERSION = 1;
export const AUTONOMY_EMERGENCY_SWITCH_READ_TIMEOUT_MS = 1_500;

export type EmergencySwitchReason =
  | "ENABLED"
  | "ENV_EMERGENCY_DISABLE"
  | "EMERGENCY_SWITCH_DISABLED"
  | "EMERGENCY_SWITCH_MISSING"
  | "EMERGENCY_SWITCH_MALFORMED"
  | "EMERGENCY_SWITCH_UNSUPPORTED_VERSION"
  | "EMERGENCY_SWITCH_INVALID"
  | "EMERGENCY_SWITCH_TIMEOUT"
  | "EMERGENCY_SWITCH_UNAVAILABLE"
  | "EMERGENCY_SWITCH_ERROR";

export interface EmergencySwitchDecision {
  allowed: boolean;
  reason: EmergencySwitchReason;
  correlationId: string;
}

export interface AutonomyEmergencySwitchRecord {
  v: number;
  enabled: boolean;
  updatedAt: string;
  updatedBy?: string;
  note?: string;
}

export interface EmergencySwitchKv {
  get(key: string): Promise<unknown>;
}

let injectedKv: EmergencySwitchKv | null | undefined;
let injectedReader: (() => Promise<EmergencySwitchDecision>) | null = null;

/** Test-only: inject a KV client (or `null` to force unavailable). */
export function setEmergencySwitchKvForTests(kv: EmergencySwitchKv | null | undefined): void {
  injectedKv = kv;
}

/** Test-only: short-circuit the reader (cleared with `null`). */
export function setEmergencySwitchReaderForTests(reader: (() => Promise<EmergencySwitchDecision>) | null): void {
  injectedReader = reader;
}

export function resetEmergencySwitchForTests(): void {
  injectedKv = undefined;
  injectedReader = null;
}

export function parseAutonomyEmergencySwitchRecord(raw: unknown): {
  ok: true;
  record: AutonomyEmergencySwitchRecord;
} | {
  ok: false;
  reason: Extract<
    EmergencySwitchReason,
    | "EMERGENCY_SWITCH_MISSING"
    | "EMERGENCY_SWITCH_MALFORMED"
    | "EMERGENCY_SWITCH_UNSUPPORTED_VERSION"
    | "EMERGENCY_SWITCH_INVALID"
  >;
} {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "EMERGENCY_SWITCH_MISSING" };
  }
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, reason: "EMERGENCY_SWITCH_MALFORMED" };
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return { ok: false, reason: "EMERGENCY_SWITCH_MALFORMED" };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "EMERGENCY_SWITCH_MALFORMED" };
  }
  const rec = value as Record<string, unknown>;
  if (!("v" in rec) || !("enabled" in rec) || !("updatedAt" in rec)) {
    return { ok: false, reason: "EMERGENCY_SWITCH_MALFORMED" };
  }
  if (typeof rec.v !== "number" || !Number.isInteger(rec.v)) {
    return { ok: false, reason: "EMERGENCY_SWITCH_MALFORMED" };
  }
  if (rec.v !== AUTONOMY_EMERGENCY_SWITCH_SCHEMA_VERSION) {
    return { ok: false, reason: "EMERGENCY_SWITCH_UNSUPPORTED_VERSION" };
  }
  if (typeof rec.enabled !== "boolean") {
    return { ok: false, reason: "EMERGENCY_SWITCH_INVALID" };
  }
  if (typeof rec.updatedAt !== "string" || Number.isNaN(Date.parse(rec.updatedAt))) {
    return { ok: false, reason: "EMERGENCY_SWITCH_INVALID" };
  }
  if (rec.updatedBy !== undefined && typeof rec.updatedBy !== "string") {
    return { ok: false, reason: "EMERGENCY_SWITCH_INVALID" };
  }
  if (rec.note !== undefined && typeof rec.note !== "string") {
    return { ok: false, reason: "EMERGENCY_SWITCH_INVALID" };
  }
  return {
    ok: true,
    record: {
      v: rec.v,
      enabled: rec.enabled,
      updatedAt: rec.updatedAt,
      ...(typeof rec.updatedBy === "string" ? { updatedBy: rec.updatedBy } : {}),
      ...(typeof rec.note === "string" ? { note: rec.note } : {}),
    },
  };
}

function resolveKv(): EmergencySwitchKv | null {
  if (injectedKv !== undefined) return injectedKv;
  try {
    return getRedis();
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("EMERGENCY_SWITCH_TIMEOUT")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Authoritative uncached read. Never logs record contents or credentials.
 */
export async function readAutonomousEmergencySwitch(correlationId: string = randomUUID()): Promise<EmergencySwitchDecision> {
  if (isAutonomousExecutionEmergencyDisabled()) {
    return { allowed: false, reason: "ENV_EMERGENCY_DISABLE", correlationId };
  }

  if (injectedReader) {
    const decision = await injectedReader();
    return { ...decision, correlationId: decision.correlationId || correlationId };
  }

  const kv = resolveKv();
  if (!kv) {
    return { allowed: false, reason: "EMERGENCY_SWITCH_UNAVAILABLE", correlationId };
  }

  let raw: unknown;
  try {
    raw = await withTimeout(kv.get(AUTONOMY_EMERGENCY_SWITCH_KEY), AUTONOMY_EMERGENCY_SWITCH_READ_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "EMERGENCY_SWITCH_TIMEOUT") {
      return { allowed: false, reason: "EMERGENCY_SWITCH_TIMEOUT", correlationId };
    }
    return { allowed: false, reason: "EMERGENCY_SWITCH_ERROR", correlationId };
  }

  const parsed = parseAutonomyEmergencySwitchRecord(raw);
  if (!parsed.ok) {
    return { allowed: false, reason: parsed.reason, correlationId };
  }
  if (parsed.record.enabled !== true) {
    return { allowed: false, reason: "EMERGENCY_SWITCH_DISABLED", correlationId };
  }
  return { allowed: true, reason: "ENABLED", correlationId };
}

export function logEmergencySwitchDecision(
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void; debug?: (msg: string, meta?: Record<string, unknown>) => void },
  decision: EmergencySwitchDecision,
  extra: Record<string, unknown> = {},
): void {
  const meta = {
    code: decision.reason,
    correlationId: decision.correlationId,
    allowed: decision.allowed,
    key: AUTONOMY_EMERGENCY_SWITCH_KEY,
    ...extra,
  };
  if (!decision.allowed) {
    logger.warn("autonomy emergency switch refused execution", meta);
  } else {
    logger.debug?.("autonomy emergency switch allowed execution", meta);
  }
}
