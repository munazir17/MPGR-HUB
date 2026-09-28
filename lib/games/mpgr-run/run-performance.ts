/** Opt-in, local-only interaction triage (?runPerf=1). Not an INP calculator
 * or a replacement for a browser Performance trace. No telemetry, wallet,
 * input coordinates, DOM text or gameplay state is collected. */
export function runPerformanceRequested(search: string): boolean {
  return new URLSearchParams(search).get("runPerf") === "1";
}

class Samples {
  private readonly values = new Float64Array(256);
  private count = 0;
  record(ms: number) {
    this.values[this.count++ % this.values.length] = ms;
  }
  snapshot() {
    const values = Array.from(this.values.subarray(0, Math.min(this.count, this.values.length))).sort((a, b) => a - b);
    return { totalSamples: this.count, retainedSamples: values.length,
      medianMs: values.length ? values[Math.floor(values.length / 2)] : null,
      p95Ms: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] : null,
      maxMs: values.length ? values[values.length - 1] : null };
  }
}

type TimedInteraction = {
  name: string; interactionId: number; startTime: number; durationMs: number;
  inputDelayMs: number; handlerMs: number; presentationDelayMs: number;
};
type LongTask = { startTime: number; durationMs: number };

export function createRunPerformanceReport() {
  const render = new Samples(), simulation = new Samples();
  const events: TimedInteraction[] = [], longTasks: LongTask[] = [];
  const observers: PerformanceObserver[] = [];
  const startedAt = performance.now();
  const supported = { eventTiming: false, longTask: false };
  let stopped = false;
  const observe = (type: string, receive: (entry: PerformanceEntry) => void): boolean => {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes(type)) return false;
    try {
      const observer = new PerformanceObserver(list => {
        if (stopped) return;
        for (const entry of list.getEntries()) if (entry.startTime >= startedAt) receive(entry);
      });
      observer.observe({ type, buffered: true, ...(type === "event" ? { durationThreshold: 16 } : {}) });
      observers.push(observer);
      return true;
    } catch { return false; }
  };
  supported.eventTiming = observe("event", entry => {
    const e = entry as PerformanceEventTiming & { interactionId?: number };
    if (!e.interactionId) return;
    if (events.length === 64) events.shift();
    events.push({ name: e.name, interactionId: e.interactionId, startTime: e.startTime,
      durationMs: e.duration, inputDelayMs: Math.max(0, e.processingStart - e.startTime),
      handlerMs: Math.max(0, e.processingEnd - e.processingStart),
      presentationDelayMs: Math.max(0, e.startTime + e.duration - e.processingEnd) });
  });
  supported.longTask = observe("longtask", entry => {
    if (longTasks.length === 64) longTasks.shift();
    longTasks.push({ startTime: entry.startTime, durationMs: entry.duration });
  });
  const snapshot = () => ({
    note: "Local triage only, NOT page INP. Event durations are browser-quantized; entries below 16ms are omitted. JS draw-command time excludes deferred raster/compositing. Last 256 render/step samples and 64 event/long-task entries retained.",
    supported: { ...supported }, startedAt, capturedAt: performance.now(),
    renderCommandJs: render.snapshot(), simulationJs: simulation.snapshot(),
    events: events.slice(), longTasks: longTasks.slice(),
  });
  return {
    recordRender: (ms: number) => { if (!stopped) render.record(ms); },
    recordSimulation: (ms: number) => { if (!stopped) simulation.record(ms); },
    snapshot,
    download() {
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "mpgr-run-performance.json";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    stop() { stopped = true; for (const observer of observers) observer.disconnect(); },
  };
}

export type RunPerformanceReport = ReturnType<typeof createRunPerformanceReport>;

declare global {
  interface Window { __mpgrRunPerformance?: RunPerformanceReport; }
}
