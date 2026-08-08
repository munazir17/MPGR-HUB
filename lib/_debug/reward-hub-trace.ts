// lib/_debug/reward-hub-trace.ts
//
// TEMPORARY Phase 3F Reward Hub diagnostic instrumentation.
// This file is intentionally isolated so the trace can be removed
// completely after the performance bottleneck is identified.

type TraceMeta = Record<string, unknown>;

const timers = new Map<string, number>();

function now(): number {
  return typeof performance !== "undefined"
    ? performance.now()
    : Date.now();
}

function formatMeta(meta?: TraceMeta): string {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return "";
  }
}

export const trace = {
  start(label: string, meta?: TraceMeta): number {
    const started = now();
    timers.set(label, started);

    console.log(
      `[RewardHub TRACE] ${label} START${formatMeta(meta)}`
    );

    return started;
  },

  end(
    label: string,
    started: number,
    meta?: TraceMeta
  ): number {
    const elapsed = now() - started;

    console.log(
      `[RewardHub TRACE] ${label} END ${elapsed.toFixed(1)}ms${formatMeta(meta)}`
    );

    return elapsed;
  },

  mark(label: string, meta?: TraceMeta): void {
    console.log(
      `[RewardHub TRACE] ${label}${formatMeta(meta)}`
    );
  },

  elapsed(label: string): number | null {
    const started = timers.get(label);

    if (started === undefined) {
      return null;
    }

    return now() - started;
  },

  clear(label?: string): void {
    if (label) {
      timers.delete(label);
    } else {
      timers.clear();
    }
  },
} as const;
