import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunPerformanceReport, runPerformanceRequested } from "./run-performance";

afterEach(() => vi.unstubAllGlobals());
describe("local opt-in interaction triage", () => {
  it("is disabled by default and requires an explicit query flag", () => {
    expect(runPerformanceRequested("")).toBe(false);
    expect(runPerformanceRequested("?runPerf=0")).toBe(false);
    expect(runPerformanceRequested("?runPerf=1")).toBe(true);
  });
  it("bounds per-frame storage and explicitly reports unsupported observers", () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    const report = createRunPerformanceReport();
    for (let i = 0; i < 1000; i++) report.recordRender(i);
    report.recordSimulation(2);
    const snapshot = report.snapshot();
    expect(snapshot.renderCommandJs).toMatchObject({ totalSamples: 1000, retainedSamples: 256, maxMs: 999 });
    expect(snapshot.simulationJs.maxMs).toBe(2);
    expect(snapshot.supported).toEqual({ eventTiming: false, longTask: false });
    report.stop(); report.recordRender(9999);
    expect(report.snapshot().renderCommandJs.maxMs).toBe(999);
  });
  it("separates input delay, handler work and next-paint delay without DOM data", () => {
    const callbacks = new Map<string, (list: { getEntries: () => PerformanceEntry[] }) => void>();
    const disconnect = vi.fn();
    class Observer {
      static supportedEntryTypes = ["event", "longtask"];
      constructor(private callback: (list: { getEntries: () => PerformanceEntry[] }) => void) {}
      observe(options: PerformanceObserverInit) { callbacks.set(options.type!, this.callback); }
      disconnect = disconnect;
    }
    vi.stubGlobal("PerformanceObserver", Observer);
    const report = createRunPerformanceReport(), startTime = performance.now() + 1;
    const e = { name: "pointerup", interactionId: 42, startTime, duration: 272,
      processingStart: startTime + 100, processingEnd: startTime + 104, target: { privateText: "must not be copied" } };
    for (let i = 0; i < 80; i++) callbacks.get("event")!({ getEntries: () => [e as unknown as PerformanceEntry] });
    callbacks.get("longtask")!({ getEntries: () => [{ startTime, duration: 120 } as PerformanceEntry] });
    const snapshot = report.snapshot();
    expect(snapshot.events).toHaveLength(64);
    // Performance timestamps are fractional; subtraction can differ by an
    // IEEE-754 rounding epsilon (e.g. 168.00000000000003).
    expect(snapshot.events[0].inputDelayMs).toBeCloseTo(100, 8);
    expect(snapshot.events[0].handlerMs).toBeCloseTo(4, 8);
    expect(snapshot.events[0].presentationDelayMs).toBeCloseTo(168, 8);
    expect(JSON.stringify(snapshot)).not.toContain("privateText");
    expect(snapshot.longTasks).toEqual([{ startTime, durationMs: 120 }]);
    report.stop(); expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
