export const MPGR_RUN_TRACE_VERSION = 1;

export type RunInputEvent =
  | {
      type: "jump";
      atMs: number;
    }
  | {
      type: "slide";
      atMs: number;
    }
  | {
      type: "lane";
      atMs: number;
      dir: -1 | 1;
    };

export interface RunInputTrace {
  version: number;
  events: RunInputEvent[];
}

export function createRunInputTrace(): RunInputTrace {
  return {
    version: MPGR_RUN_TRACE_VERSION,
    events: [],
  };
}

export const MPGR_RUN_FIXED_DT_MS = 1000 / 60;

export function snapToSimulationTick(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  const tick = Math.round(ms / MPGR_RUN_FIXED_DT_MS);
  return tick * MPGR_RUN_FIXED_DT_MS;
}

export function snapDurationToSimulationTicks(ms: number): number {
  const snapped = snapToSimulationTick(ms);
  return Math.round(snapped);
}

export function appendRunInputEvent(
  trace: RunInputTrace,
  event: RunInputEvent,
): void {
  event = { ...event, atMs: snapToSimulationTick(event.atMs) };
  if (!Number.isFinite(event.atMs) || event.atMs < 0) {
    throw new Error("Input event timestamp must be a non-negative finite number");
  }

  if (event.type === "lane" && event.dir !== -1 && event.dir !== 1) {
    throw new Error("Lane direction must be -1 or 1");
  }

  const previous = trace.events[trace.events.length - 1];

  if (previous && event.atMs < previous.atMs) {
    throw new Error("Input events must be ordered by timestamp");
  }

  trace.events.push(event);
}

export function cloneRunInputTrace(trace: RunInputTrace): RunInputTrace {
  return {
    version: trace.version,
    events: trace.events.map((event) => ({ ...event })),
  };
}
