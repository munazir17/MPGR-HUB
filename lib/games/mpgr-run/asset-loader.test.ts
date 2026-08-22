import { describe, expect, it } from "vitest";
import {
  startRunAssetPipeline,
  type LoadableImage,
  type RunAssetPipelineDeps,
  type SpriteReadyCache,
} from "./asset-loader";

class FakeImage implements LoadableImage {
  src = "";
  decoding = "async";
  naturalWidth = 32;
  naturalHeight = 32;
  onload: LoadableImage["onload"] = null;
  onerror: LoadableImage["onerror"] = null;
}

interface Clock {
  now: number;
  timers: { id: number; due: number; cb: () => void; cancelled: boolean }[];
  nextId: number;
  schedule: (cb: () => void, ms: number) => number;
  cancel: (id: number) => void;
  advance: (ms: number) => Promise<void>;
}

function createClock(): Clock {
  const clock: Clock = {
    now: 0,
    timers: [],
    nextId: 1,
    schedule(cb, ms) {
      const id = clock.nextId++;
      clock.timers.push({ id, due: clock.now + ms, cb, cancelled: false });
      return id;
    },
    cancel(id) {
      const t = clock.timers.find((entry) => entry.id === id);
      if (t) t.cancelled = true;
    },
    async advance(ms) {
      clock.now += ms;
      const due = clock.timers.filter((t) => !t.cancelled && t.due <= clock.now);
      for (const t of due) {
        t.cancelled = true;
        t.cb();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
  return clock;
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function setup(opts?: {
  critical?: string[];
  optional?: string[];
  criticalConcurrency?: number;
  optionalConcurrency?: number;
  timeoutMs?: number;
  strip?: string[];
  holdDecode?: boolean;
}) {
  const ready: SpriteReadyCache = new Map();
  const inflight = new Set<string>();
  const failed = new Set<string>();
  const created: FakeImage[] = [];
  const clock = createClock();
  const decodeGates = new Map<FakeImage, () => void>();

  const deps: RunAssetPipelineDeps = {
    createImage: () => {
      const img = new FakeImage();
      created.push(img);
      return img;
    },
    decode: (img) => {
      if (!opts?.holdDecode) return Promise.resolve();
      return new Promise<void>((resolve) => {
        decodeGates.set(img as FakeImage, resolve);
      });
    },
    scheduleTimeout: (cb, ms) => clock.schedule(cb, ms),
    cancelTimeout: (id) => clock.cancel(id),
  };

  const pipeline = startRunAssetPipeline({
    critical: opts?.critical ?? [],
    optional: opts?.optional ?? [],
    ready,
    inflight,
    failed,
    stripTargets: new Set(opts?.strip ?? []),
    stripBackground: () => ({ stripped: true }) as unknown as HTMLCanvasElement,
    criticalConcurrency: opts?.criticalConcurrency ?? 2,
    optionalConcurrency: opts?.optionalConcurrency ?? 2,
    timeoutMs: opts?.timeoutMs ?? 8000,
    deps,
  });

  return {
    ready,
    inflight,
    failed,
    created,
    clock,
    pipeline,
    succeed(img: FakeImage) {
      img.onload?.call(img);
    },
    fail(img: FakeImage) {
      img.onerror?.call(img);
    },
    releaseDecode(img: FakeImage) {
      const gate = decodeGates.get(img);
      if (!gate) throw new Error("no decode gate for image");
      gate();
    },
  };
}

describe("true slot concurrency", () => {
  it("never exceeds criticalConcurrency actually in-flight", async () => {
    const ctx = setup({
      critical: ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"],
      criticalConcurrency: 2,
    });
    expect(ctx.created).toHaveLength(2);
    expect(ctx.pipeline.getCriticalInFlight()).toBe(2);
    expect(ctx.inflight.size).toBe(2);

    ctx.succeed(ctx.created[0]);
    await flushMicrotasks();
    expect(ctx.ready.has("/a.png")).toBe(true);
    expect(ctx.created).toHaveLength(3);
    expect(ctx.pipeline.getCriticalInFlight()).toBe(2);
    expect(ctx.inflight.size).toBe(2);
  });

  it("holds the slot through decode, not just through onload", async () => {
    const ctx = setup({
      critical: ["/a.png", "/b.png"],
      criticalConcurrency: 1,
      holdDecode: true,
    });
    expect(ctx.created).toHaveLength(1);
    ctx.succeed(ctx.created[0]);
    await flushMicrotasks();
    // onload fired, decode still pending — slot still occupied, next not started
    expect(ctx.ready.size).toBe(0);
    expect(ctx.pipeline.getCriticalInFlight()).toBe(1);
    expect(ctx.created).toHaveLength(1);

    ctx.releaseDecode(ctx.created[0]);
    await flushMicrotasks();
    expect(ctx.ready.has("/a.png")).toBe(true);
    expect(ctx.created).toHaveLength(2);
    expect(ctx.created[1].src).toBe("/b.png");
  });
});

describe("queue progression", () => {
  it("starts the next queued asset after success", async () => {
    const ctx = setup({
      critical: ["/a.png", "/b.png", "/c.png"],
      criticalConcurrency: 1,
    });
    expect(ctx.created.map((img) => img.src)).toEqual(["/a.png"]);
    ctx.succeed(ctx.created[0]);
    await flushMicrotasks();
    expect(ctx.created.map((img) => img.src)).toEqual(["/a.png", "/b.png"]);
    ctx.succeed(ctx.created[1]);
    await flushMicrotasks();
    expect(ctx.created.map((img) => img.src)).toEqual(["/a.png", "/b.png", "/c.png"]);
  });

  it("starts the next queued asset after error", async () => {
    const ctx = setup({
      critical: ["/a.png", "/b.png"],
      criticalConcurrency: 1,
    });
    ctx.fail(ctx.created[0]);
    await flushMicrotasks();
    expect(ctx.failed.has("/a.png")).toBe(true);
    expect(ctx.ready.has("/a.png")).toBe(false);
    expect(ctx.created[1].src).toBe("/b.png");
    expect(ctx.pipeline.getCriticalInFlight()).toBe(1);
  });

  it("starts the next queued asset after timeout", async () => {
    const ctx = setup({
      critical: ["/a.png", "/b.png"],
      criticalConcurrency: 1,
      timeoutMs: 50,
    });
    expect(ctx.created).toHaveLength(1);
    await ctx.clock.advance(50);
    expect(ctx.failed.has("/a.png")).toBe(true);
    expect(ctx.created[1].src).toBe("/b.png");
    expect(ctx.pipeline.getCriticalInFlight()).toBe(1);
  });
});

describe("optional gating", () => {
  it("does not start optional just because critical has started", async () => {
    const ctx = setup({
      critical: ["/c1.png", "/c2.png"],
      optional: ["/o1.png"],
      criticalConcurrency: 2,
    });
    expect(ctx.pipeline.optionalHasStarted()).toBe(false);
    expect(ctx.created.map((img) => img.src)).toEqual(["/c1.png", "/c2.png"]);
    ctx.succeed(ctx.created[0]);
    await flushMicrotasks();
    expect(ctx.pipeline.optionalHasStarted()).toBe(false);
    expect(ctx.created.some((img) => img.src === "/o1.png")).toBe(false);
  });

  it("starts optional only after every critical asset has settled", async () => {
    const ctx = setup({
      critical: ["/c1.png", "/c2.png"],
      optional: ["/o1.png", "/o2.png"],
      criticalConcurrency: 2,
      optionalConcurrency: 2,
    });
    ctx.succeed(ctx.created[0]);
    ctx.fail(ctx.created[1]);
    await flushMicrotasks();
    expect(ctx.pipeline.optionalHasStarted()).toBe(true);
    expect(ctx.pipeline.getCriticalSettled()).toBe(2);
    expect(ctx.created.some((img) => img.src === "/o1.png")).toBe(true);
    expect(ctx.created.some((img) => img.src === "/o2.png")).toBe(true);
  });
});

describe("ready cache rules", () => {
  it("is write-once — a later settle cannot replace a ready sprite", async () => {
    const ctx = setup({ critical: ["/a.png"], criticalConcurrency: 1 });
    const first = ctx.created[0];
    ctx.succeed(first);
    await flushMicrotasks();
    const stored = ctx.ready.get("/a.png");
    expect(stored).toBe(first);

    first.onload?.call(first);
    await flushMicrotasks();
    expect(ctx.ready.get("/a.png")).toBe(stored);
  });

  it("marks failed assets sticky and never puts them in ready", async () => {
    const ctx = setup({ critical: ["/miss.png"], criticalConcurrency: 1 });
    ctx.fail(ctx.created[0]);
    await flushMicrotasks();
    expect(ctx.failed.has("/miss.png")).toBe(true);
    expect(ctx.ready.has("/miss.png")).toBe(false);
    ctx.succeed(ctx.created[0]);
    await flushMicrotasks();
    expect(ctx.ready.has("/miss.png")).toBe(false);
  });
});

describe("cancellation", () => {
  it("does not write to the ready cache after stop()", async () => {
    const ctx = setup({
      critical: ["/a.png", "/b.png"],
      optional: ["/o.png"],
      criticalConcurrency: 1,
    });
    ctx.pipeline.stop();
    ctx.succeed(ctx.created[0]);
    await flushMicrotasks();
    await ctx.clock.advance(8000);
    expect(ctx.ready.size).toBe(0);
    expect(ctx.created).toHaveLength(1);
  });
});
