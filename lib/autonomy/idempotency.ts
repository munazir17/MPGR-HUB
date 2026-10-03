// lib/autonomy/idempotency.ts
//
// Idempotency helpers (spec §17). Pure string/time logic + a claim function
// delegated to the store. Keys are derived deterministically so that React
// rerenders, browser refreshes, server retries, webhook retries, RPC
// timeouts and worker retries all collapse onto ONE key.
//
//   evaluation slot : bucket(goal.nextEvaluationAt)  — one evaluation per slot
//   execution key   : goalId:slot                    — one execution per slot
//
// Slots bucket by the SCHEDULED evaluation time (not wall-clock), so a tick
// that runs late still maps to the same slot as the tick that was on time.

export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function slotBucket(scheduledAtMs: number, cooldownSeconds: number): number {
  const windowMs = Math.max(cooldownSeconds, 1) * 1000;
  return Math.floor(scheduledAtMs / windowMs);
}

export function evaluationSlotKey(goalId: string, nextEvaluationAt: string): string {
  return `${goalId}:${nextEvaluationAt}`;
}

export function executionIdempotencyKey(goalId: string, slotKey: string): string {
  return `${goalId}:${slotKey}`;
}

export function makeId(prefix: string, now: Date, entropy: string): string {
  const rand = entropy || Math.random().toString(36).slice(2, 10);
  return `${prefix}_${now.getTime().toString(36)}_${rand}`;
}
